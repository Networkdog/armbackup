from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
import requests
import test_console

from armbackup.archive import BlobArchive
from armbackup.contracts import BackupError
from armbackup.webui import PreviewHandler
from http.server import ThreadingHTTPServer
import threading

console = test_console.console
live_url = test_console.live_url


class ExploreBlobContainer:
    def __init__(self, entries):
        self.entries = list(entries)
        self.calls = []

    def get_container_properties(self):
        return {}

    def list_blobs(self, *, name_starts_with=None):
        self.calls.append(name_starts_with)
        for item in self.entries:
            if name_starts_with is None or item.name.startswith(name_starts_with):
                yield item


def make_blob(name, size, modified="2026-11-23T02:00:00Z", content_type="application/json", tier="Hot"):
    dt = datetime.fromisoformat(modified.replace("Z", "+00:00")) if modified else None
    settings = SimpleNamespace(content_type=content_type) if content_type else None
    return SimpleNamespace(name=name, size=size, last_modified=dt, content_settings=settings, blob_tier=tier)


def test_blob_archive_explore_aggregates_container_skips_folder_stubs_and_bounds_prefix(config):
    entries = [
        make_blob("armbackup/", 0, content_type="", tier=""),
        make_blob("armbackup/runs/20261123T020000Z-aabbccddeeff/manifest.json", 1420),
        make_blob("armbackup/runs/20261123T020000Z-aabbccddeeff/resources/abc.json", 98304),
        make_blob("armbackup/runs-other/unrelated.json", 512),
        make_blob("other-prefix/notes.txt", 128, content_type="text/plain", tier="Cool"),
    ]
    container = ExploreBlobContainer(entries)
    with patch("armbackup.archive.private_storage_check"), patch(
        "armbackup.archive.ContainerClient", return_value=container,
    ):
        archive = BlobArchive(config, Mock())
        full = archive.explore()
        assert container.calls[-1] is None
        assert full["truncated"] is False
        assert full["configuredPrefix"] == config.prefix
        assert [b["name"] for b in full["blobs"]] == [
            "armbackup/runs-other/unrelated.json",
            "armbackup/runs/20261123T020000Z-aabbccddeeff/manifest.json",
            "armbackup/runs/20261123T020000Z-aabbccddeeff/resources/abc.json",
            "other-prefix/notes.txt",
        ]
        assert full["blobs"][-1]["tier"] == "Cool"
        assert full["blobs"][-1]["contentType"] == "text/plain"

        scoped = archive.explore("armbackup/runs/")
        assert container.calls[-1] == "armbackup/runs/"
        assert [b["name"] for b in scoped["blobs"]] == [
            "armbackup/runs/20261123T020000Z-aabbccddeeff/manifest.json",
            "armbackup/runs/20261123T020000Z-aabbccddeeff/resources/abc.json",
        ]

        limited = archive.explore(limit=2)
        assert limited["truncated"] is True
        assert limited["scanLimit"] == 2
        assert len(limited["blobs"]) == 2


@pytest.mark.parametrize("bad_prefix", ["/", "/armbackup", "../secret", "a/../b", "a//b", "a\\b", "a\x00b"])
def test_archive_explore_rejects_unsafe_prefixes(console, bad_prefix):
    with pytest.raises(BackupError, match="prefix"):
        console.archive.explore(bad_prefix)


def test_local_archive_explore_reports_sizes_and_ignores_temp_files(console):
    temp = console.archive.root / "runs" / ".writing-temp.json"
    temp.write_bytes(b"in-flight")
    listing = console.archive.explore()
    names = [b["name"] for b in listing["blobs"]]
    assert any(name.endswith("/manifest.json") for name in names)
    assert all(".writing-" not in name for name in names)
    assert all(b["size"] > 0 and b["lastModified"].endswith("Z") for b in listing["blobs"])

    empty_sub = console.archive.explore("runs/nonexistent-run")
    assert empty_sub["blobs"] == [] and empty_sub["truncated"] is False


def test_console_storage_explorer_and_http_route_work_in_local_blob_and_hosted_modes(live_url, config):
    url, server = live_url
    headers = {"X-Console-Token": server.session_token, "Origin": url}
    assert requests.get(url + "/api/storage", timeout=5).status_code == 403

    local_resp = requests.get(url + "/api/storage", headers=headers, timeout=5)
    assert local_resp.status_code == 200
    payload = local_resp.json()
    assert payload["archiveMode"] == "local"
    assert payload["accountUrl"] == "" and payload["container"] == ""
    assert payload["localPath"] == str(server.console.config.local_archive)
    assert payload["blobCount"] == len(payload["blobs"]) > 0
    assert payload["totalBytes"] == sum(item["size"] for item in payload["blobs"])

    scoped_resp = requests.get(url + "/api/storage?prefix=runs", headers=headers, timeout=5)
    assert scoped_resp.status_code == 200
    assert all(item["name"].startswith("runs/") for item in scoped_resp.json()["blobs"])

    bad_resp = requests.get(url + "/api/storage?prefix=../etc", headers=headers, timeout=5)
    assert bad_resp.status_code == 400

    # Hosted snapshot_only mode reads directly from archive without touching ARM.
    server.console.snapshot_only = True
    server.console.arm.request = Mock(side_effect=AssertionError("Storage explorer must not call ARM"))
    hosted_payload = server.console.storage_explorer()
    assert hosted_payload["blobCount"] == payload["blobCount"]

    # Blob mode populates Storage account and container metadata.
    container = ExploreBlobContainer([make_blob("armbackup/runs/r1/manifest.json", 2048)])
    with patch("armbackup.archive.private_storage_check"), patch(
        "armbackup.archive.ContainerClient", return_value=container,
    ):
        blob_archive = BlobArchive(config, Mock())
    server.console.config = replace(server.console.config, archive_mode="blob", local_archive=None)
    server.console.archive = blob_archive
    blob_payload = server.console.storage_explorer()
    assert blob_payload["archiveMode"] == "blob"
    assert blob_payload["container"] == config.container
    assert blob_payload["accountUrl"] == config.storage_url
    assert blob_payload["accountName"] == config.storage_url.split("//", 1)[1].split(".", 1)[0]
    assert blob_payload["totalBytes"] == 2048


def test_design_preview_server_serves_storage_module_and_keeps_api_storage_unexposed():
    preview = ThreadingHTTPServer(("127.0.0.1", 0), PreviewHandler)
    thread = threading.Thread(target=preview.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{preview.server_port}"
        asset = requests.get(base + "/storage-explorer.mjs", timeout=5)
        assert asset.status_code == 200 and "buildStorageIndex" in asset.text
        assert requests.get(base + "/api/storage", timeout=5).status_code == 404
    finally:
        preview.shutdown()
        preview.server_close()
        thread.join(timeout=5)
