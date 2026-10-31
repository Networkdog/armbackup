import importlib.util
import json
import threading
from dataclasses import replace
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

import pytest
import requests
from azure.core.exceptions import HttpResponseError, ResourceExistsError
from conftest import RID, ROOT, SID, CaptureArm, MemoryArchive, MemoryEvents
from test_http_archive_logs import dcr

from armbackup.archive import BlobArchive
from armbackup.backup import Backup
from armbackup.cli import main
from armbackup.config import Collection
from armbackup.contracts import ArmHttpError, BackupError, digest, encode_json
from armbackup.discovery import ApiResolver, Resource, discover, subscriptions
from armbackup.events import LOG_COLUMNS, verify_log_destination
from armbackup.restore import apply_plan, build_plan


def test_backup_cli_complete_pipeline(config, capsys):
    arm, archive, events = CaptureArm(), MemoryArchive(), MemoryEvents()
    with patch("armbackup.cli.Config.load", return_value=config), patch(
        "armbackup.cli.credential"
    ), patch("armbackup.cli.ArmClient", return_value=arm), patch(
        "armbackup.cli.verify_log_destination"
    ), patch("armbackup.cli.LogAnalyticsEvents", return_value=events), patch(
        "armbackup.cli.BlobArchive", return_value=archive
    ), patch("armbackup.cli.new_run_id", return_value="20261031T000000Z-abcdef123456"):
        assert main(["backup"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "Captured"
    assert len(archive.data) == 4
    assert events.records[-1]["Event"] == "capture_finished"
    assert events.flushes == 2


def test_backup_cli_partial_returns_nonzero(config):
    arm = CaptureArm()
    arm.fail_capture = True
    with patch("armbackup.cli.Config.load", return_value=config), patch(
        "armbackup.cli.credential"
    ), patch("armbackup.cli.ArmClient", return_value=arm), patch(
        "armbackup.cli.verify_log_destination"
    ), patch("armbackup.cli.LogAnalyticsEvents", return_value=MemoryEvents()), patch(
        "armbackup.cli.BlobArchive", return_value=MemoryArchive()
    ):
        assert main(["backup"]) == 2


def test_supplemental_failure_not_a_successful_parent(config):
    class FailedCollection(CaptureArm):
        def pages(self, path, api_version):
            if path != "/subscriptions":
                raise BackupError("required collection forbidden")
            yield from super().pages(path, api_version)
    config = replace(config, collections={"microsoft.network/networksecuritygroups": (
        Collection("securityRules", "securityRules", "2024-05-01", "list"),
    )})
    result = Backup(config, FailedCollection(), MemoryArchive(), MemoryEvents()).run("test-run")
    assert result["status"] == "Incomplete"
    assert result["capturedCount"] == 0


def test_empty_enabled_scope_rejected(config):
    arm = Mock()
    arm.pages.return_value = iter([{"subscriptionId": SID, "state": "Disabled"}])
    with pytest.raises(BackupError):
        subscriptions(arm, replace(config, subscriptions=()))


def test_only_preview_is_not_implicitly_used(config):
    arm = Mock()
    arm.request.return_value = {"resourceTypes": [{
        "resourceType": "newThings", "apiVersions": ["2026-01-01-preview"],
    }]}
    resource = Resource(RID, "microsoft.example/newthings", SID, "test")
    with pytest.raises(BackupError, match="No supported"):
        ApiResolver(arm, config).resolve(resource)
    assert ApiResolver(arm, replace(config, allow_preview=True)).resolve(resource) == "2026-01-01-preview"


def test_thousands_of_discovery_rows_all_paginated(config):
    rows = [{"id": RID + str(i), "type": "microsoft.network/networksecuritygroups"}
            for i in range(2501)]
    arm = CaptureArm()
    arm.responses = [
        {"data": rows[:1000], "totalRecords": 2501, "$skipToken": "1000"},
        {"data": rows[1000:2000], "totalRecords": 2501, "$skipToken": "2000"},
        {"data": rows[2000:], "totalRecords": 2501, "resultTruncated": False},
    ]
    resources, failures = discover(arm, config, [SID], MemoryEvents())
    assert len(resources) == 2501
    assert not failures


def test_route_table_plan_and_apply():
    target = RID.replace("networkSecurityGroups", "routeTables")
    raw = {"location": "koreacentral", "tags": {}, "properties": {
        "disableBgpRoutePropagation": True, "provisioningState": "Succeeded",
        "routes": [{"name": "default", "properties": {
            "addressPrefix": "0.0.0.0/0", "nextHopType": "VirtualAppliance",
            "nextHopIpAddress": "10.1.1.4", "provisioningState": "Succeeded",
        }}],
    }}
    snapshot = {"schemaVersion": 1, "resourceId": target, "captureApiVersion": "2024-05-01",
                "resourceType": "microsoft.network/routetables", "raw": raw}
    plan = build_plan(snapshot, target, "2024-05-01")
    arm = Mock()
    arm.request.side_effect = [ArmHttpError(404, "NotFound"), {}, raw]
    outcome = apply_plan(plan, digest(encode_json(plan)), arm, MemoryEvents())
    assert outcome["status"] == "Succeeded"
    assert plan["body"]["properties"]["routes"][0]["properties"]["nextHopIpAddress"] == "10.1.1.4"


def test_retired_restore_api_does_not_send_put():
    from test_restore_package_cli import snapshot
    plan = build_plan(snapshot(), RID, "2024-05-01")
    arm = Mock()
    arm.request.side_effect = ArmHttpError(400, "InvalidApiVersionParameter")
    with pytest.raises(ArmHttpError):
        apply_plan(plan, digest(encode_json(plan)), arm, MemoryEvents())
    assert arm.request.call_count == 1


def test_restore_no_audit_delivery_no_write():
    from test_restore_package_cli import snapshot
    plan = build_plan(snapshot(), RID, "2024-05-01")
    arm, events = Mock(), MemoryEvents()
    events.fail_at = 1
    with pytest.raises(BackupError, match="log ingestion"):
        apply_plan(plan, digest(encode_json(plan)), arm, events)
    arm.request.assert_not_called()


def test_linked_private_dce_verifies(config):
    definition = dcr(config)
    props = definition["properties"]
    props["endpoints"] = {}
    props["dataCollectionEndpointId"] = "/subscriptions/" + SID + "/resourceGroups/monitor/providers/Microsoft.Insights/dataCollectionEndpoints/test"
    arm = Mock()
    arm.request.side_effect = [definition, {"properties": {
        "logsIngestion": {"endpoint": config.logs_endpoint},
    }}]
    verify_log_destination(config, arm)
    assert arm.request.call_count == 2


def test_endpoint_mismatch_is_not_ignored(config):
    definition = dcr(config)
    definition["properties"]["endpoints"]["logsIngestion"] = "https://wrong.ingest.monitor.azure.com"
    arm = Mock()
    arm.request.return_value = definition
    with pytest.raises(BackupError, match="neither"):
        verify_log_destination(config, arm)


def test_sample_log_matches_actual_schema():
    rows = json.loads((ROOT / "examples" / "logs-sample.json").read_text(encoding="utf-8"))
    assert set(rows[0]) == set(LOG_COLUMNS)
    assert isinstance(rows[0]["Details"], dict)


def test_blob_guard_acquires_and_releases(config):
    with patch("armbackup.archive.private_storage_check"), patch(
        "armbackup.archive.ContainerClient"
    ) as factory, patch("armbackup.archive.BlobLeaseClient") as leases:
        factory.return_value.get_blob_client.return_value.upload_blob.side_effect = ResourceExistsError()
        archive = BlobArchive(config, Mock())
        with archive.guard("capture"):
            archive.put("runs/test/raw.json", b"{}")
        leases.return_value.acquire.assert_called_once_with(lease_duration=60)
        leases.return_value.release.assert_called_once()
        assert factory.return_value.upload_blob.call_args.kwargs["overwrite"] is False


def test_blob_write_errors_sanitized(config):
    with patch("armbackup.archive.private_storage_check"), patch(
        "armbackup.archive.ContainerClient"
    ) as factory:
        archive = BlobArchive(config, Mock())
        factory.return_value.upload_blob.side_effect = HttpResponseError("SAS=secret")
        with pytest.raises(BackupError) as error:
            archive.put("runs/raw.json", b"{}")
        assert "secret" not in str(error.value)


def test_health_host_does_not_expose_files():
    spec = importlib.util.spec_from_file_location("site_health", ROOT / "webjob" / "site_health.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    server = ThreadingHTTPServer(("127.0.0.1", 0), module.Health)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}"
        assert requests.get(url + "/health", timeout=5).status_code == 200
        assert requests.get(url + "/config.json", timeout=5).status_code == 404
        assert requests.get(url + "/../config.json", timeout=5).status_code == 404
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_deployment_requires_managed_identity_and_private_storage(tmp_path, config_data):
    spec = importlib.util.spec_from_file_location("packager", ROOT / "scripts" / "package_webjob.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    path = tmp_path / "config.json"
    config_data["credential"] = "cli"
    path.write_text(json.dumps(config_data), encoding="utf-8")
    with pytest.raises(ValueError, match="managed_identity"):
        module.build(tmp_path / "invalid.zip", config_path=path, dependencies=False)


def test_linux_package_excludes_host_generated_console_launchers(tmp_path):
    import zipfile
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("packager", ROOT / "scripts" / "package_webjob.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def installer(args, **kwargs):
        destination = Path(args[args.index("--target") + 1])
        (destination / "bin").mkdir(parents=True)
        (destination / "bin" / "launcher.exe").write_bytes(b"MZ")
        (destination / "library.py").write_text("value = 1", encoding="utf-8")

    output = tmp_path / "linux.zip"
    with patch.object(module.subprocess, "run", side_effect=installer):
        module.build(output, dependencies=True)
    with zipfile.ZipFile(output) as archive:
        assert not any(n.endswith(".exe") for n in archive.namelist())
        assert any(n.endswith("library.py") for n in archive.namelist())
