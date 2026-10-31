import json
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
import requests
from azure.core.exceptions import HttpResponseError

from armbackup.archive import BlobArchive, private_storage_check
from armbackup.contracts import ArmHttpError, BackupError
from armbackup.events import LOG_COLUMNS, LogAnalyticsEvents, verify_log_destination
from armbackup.http import ArmClient, arm_url, retry_delay


def response(status=200, data=None, headers=None):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(data or {}).encode()
    result.headers.update(headers or {})
    return result


def client_with(responses):
    auth = Mock()
    auth.get_token.return_value = SimpleNamespace(token="sensitive-token")
    session = Mock()
    session.request.side_effect = responses
    client = ArmClient(auth, retries=2, sleep=lambda _: None)
    client.local.session = session
    return client, session


@pytest.mark.parametrize("url", [
    "https://evil.example.com/next", "//evil.example.com/next",
    "http://management.azure.com/a", "https://u@management.azure.com/a",
    "/a/%2e%2e/b", "/a/%5cb", "/x#fragment",
])
def test_url_escape_rejected(url):
    with pytest.raises(BackupError):
        arm_url(url, "2024-01-01")


def test_http_retry_and_token_destination():
    client, session = client_with([response(429, headers={"Retry-After": "0"}), response(data={"ok": 1})])
    assert client.request("GET", "/subscriptions", "2022-12-01") == {"ok": 1}
    assert session.request.call_count == 2
    assert session.request.call_args.kwargs["allow_redirects"] is False
    assert session.request.call_args.args[1].startswith("https://management.azure.com/")


def test_403_no_retry_and_no_secret_error_text():
    client, session = client_with([response(403, {"error": {
        "code": "AuthorizationFailed", "message": "password=secret",
    }})])
    with pytest.raises(ArmHttpError) as error:
        client.request("GET", "/x", "2024-01-01")
    assert error.value.status == 403
    assert "secret" not in str(error.value)
    assert session.request.call_count == 1


def test_transport_retries_bounded():
    client, session = client_with([requests.Timeout()] * 3)
    with pytest.raises(BackupError, match="exhausted"):
        client.request("GET", "/x", "2024-01-01")
    assert session.request.call_count == 3


def test_pagination_refuses_external_nextlink():
    client, _ = client_with([response(data={"value": [], "nextLink": "https://evil.example.com/"})])
    with pytest.raises(BackupError):
        list(client.pages("/x", "2024-01-01"))


def test_pagination_requires_value():
    client, _ = client_with([response(data={"unexpected": []})])
    with pytest.raises(BackupError):
        list(client.pages("/x", "2024-01-01"))


def test_retry_delay_bounds():
    assert retry_delay("9999", 0) == 60
    assert retry_delay("-1", 0) == 0
    assert retry_delay("bad", 3) == 8


@pytest.mark.parametrize("ips,allowed", [
    (["10.1.0.4"], True), (["172.20.0.4"], True), (["192.168.1.2"], True),
    (["127.0.0.1"], False), (["169.254.169.254"], False), (["20.1.0.1"], False),
    (["10.1.0.1", "20.1.0.1"], False),
])
def test_private_storage_dns(ips, allowed):
    with patch("armbackup.archive.socket.getaddrinfo", return_value=[
        (2, 1, 6, "", (ip, 443)) for ip in ips
    ]):
        if allowed:
            private_storage_check("https://test.blob.core.windows.net")
        else:
            with pytest.raises(BackupError):
                private_storage_check("https://test.blob.core.windows.net")


def test_blob_paths_cannot_escape(config):
    with patch("armbackup.archive.private_storage_check"), patch(
        "armbackup.archive.ContainerClient"
    ):
        archive = BlobArchive(config, Mock())
        with pytest.raises(BackupError):
            archive.get("../config")


def dcr(config):
    return {"properties": {
        "immutableId": config.logs_rule_id,
        "streamDeclarations": {config.logs_stream: {
            "columns": [{"name": k, "type": v} for k, v in LOG_COLUMNS.items()],
        }},
        "destinations": {"logAnalytics": [{"name": "logs", "workspaceResourceId": config.workspace_id}]},
        "dataFlows": [{"streams": [config.logs_stream], "destinations": ["logs"], "transformKql": "source"}],
        "endpoints": {"logsIngestion": config.logs_endpoint},
    }}


def test_dcr_destination_is_designated_workspace(config):
    arm = Mock()
    arm.request.return_value = dcr(config)
    verify_log_destination(config, arm)
    data = dcr(config)
    data["properties"]["destinations"]["logAnalytics"][0]["workspaceResourceId"] += "-wrong"
    arm.request.return_value = data
    with pytest.raises(BackupError, match="designated workspace"):
        verify_log_destination(config, arm)


def test_dcr_filter_that_silently_drops_logs_rejected(config):
    arm = Mock()
    data = dcr(config)
    data["properties"]["dataFlows"][0]["transformKql"] = "source | where false"
    arm.request.return_value = data
    with pytest.raises(BackupError):
        verify_log_destination(config, arm)


def test_log_delivery_failure_is_not_success(config, capsys):
    with patch("armbackup.events.LogsIngestionClient") as factory:
        factory.return_value.upload.side_effect = HttpResponseError("sensitive payload")
        events = LogAnalyticsEvents(config, Mock(), "run")
        events.emit("capture_started")
        with pytest.raises(BackupError):
            events.flush()
        assert len(events.buffer) == 1
        assert "sensitive payload" not in capsys.readouterr().err


def test_log_schema_and_payload_no_raw(config):
    with patch("armbackup.events.LogsIngestionClient") as factory:
        events = LogAnalyticsEvents(config, Mock(), "run")
        events.emit("resource_captured", resource_id="/resource", bytes=100)
        events.flush()
        payload = factory.return_value.upload.call_args.kwargs["logs"]
        assert isinstance(payload, list)
        assert set(payload[0]) == set(LOG_COLUMNS)
        assert payload[0]["Details"]["bytes"] == 100
        assert not events.buffer
