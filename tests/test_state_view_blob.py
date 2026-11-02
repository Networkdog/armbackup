from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from azure.core import MatchConditions
from azure.core.exceptions import (
    HttpResponseError,
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)

from armbackup.archive import BlobArchive
from armbackup.contracts import BackupError
from armbackup.state_view import StateView


class BlobContainer:
    def __init__(self):
        self.blobs = {}
        self.uploads = []
        self.downloads = []
        self.lists = 0

    def get_container_properties(self):
        return {}

    def get_blob_client(self, name):
        return Mock()

    def list_blobs(self, *, name_starts_with):
        self.lists += 1
        return [SimpleNamespace(name=name) for name in sorted(self.blobs) if name.startswith(name_starts_with)]

    def upload_blob(self, name, content, *, overwrite, etag=None, match_condition=None):
        self.uploads.append((name, overwrite, etag, match_condition))
        existing = self.blobs.get(name)
        if existing and not overwrite:
            raise ResourceExistsError()
        if etag is not None and (not existing or existing[1] != etag):
            raise ResourceModifiedError()
        self.blobs[name] = (content, f'"etag-{len(self.uploads)}"')

    def download_blob(self, name):
        self.downloads.append(name)
        if name not in self.blobs:
            raise ResourceNotFoundError()
        content, etag = self.blobs[name]
        return SimpleNamespace(readall=lambda: content, properties=SimpleNamespace(etag=etag))


def test_blob_view_uses_three_direct_reads_and_conditional_pointer_publication(config):
    container = BlobContainer()
    with patch("armbackup.archive.private_storage_check"), patch(
        "armbackup.archive.ContainerClient", return_value=container,
    ), patch("armbackup.archive.BlobLeaseClient"):
        archive = BlobArchive(config, Mock())
        view = StateView(archive, "/scope", "config-v1")
        state = {"mode": "live-lab", "workspace": {"scope": "/scope"}, "resources": []}
        assert view.build(lambda: state)["materializedView"]["persisted"]
        container.downloads.clear()
        container.lists = 0
        assert view.read()["materializedView"]["requiresLiveRefresh"]
        assert len(container.downloads) == 3
        assert container.lists == 0
        assert view.build(lambda: state)["materializedView"]["persisted"]
        pointers = [call for call in container.uploads if "/views/heads/" in call[0]]
        assert pointers[0][1:] == (False, None, None)
        assert pointers[1][1] is True and pointers[1][2]
        assert pointers[1][3] is MatchConditions.IfNotModified
        assert all(not call[1] for call in container.uploads if "/views/heads/" not in call[0])


def test_blob_pointer_conflicts_do_not_overwrite_and_auth_errors_are_not_cache_misses(config):
    container = BlobContainer()
    with patch("armbackup.archive.private_storage_check"), patch(
        "armbackup.archive.ContainerClient", return_value=container,
    ), patch("armbackup.archive.BlobLeaseClient"):
        archive = BlobArchive(config, Mock())
        view = StateView(archive, "/scope", "config-v1")
        with archive.guard("state-view"):
            assert archive.replace_pointer(view.pointer, b"initial", None)
            assert not archive.replace_pointer(view.pointer, b"stale", None)
            assert not archive.replace_pointer(view.pointer, b"stale", "wrong-etag")
            with pytest.raises(BackupError, match="Only state view"):
                archive.replace_pointer("runs/run/manifest.json", b"bad", None)
        assert archive.read_pointer(view.pointer)[0] == b"initial"
        with patch.object(container, "download_blob", side_effect=HttpResponseError("secret-token")):
            with pytest.raises(BackupError, match="pointer read failed") as error:
                archive.read_pointer(view.pointer)
            assert "secret-token" not in str(error.value)
