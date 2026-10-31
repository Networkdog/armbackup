from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path

import pytest

from armbackup.config import Config
from armbackup.contracts import BackupError

SID = "11111111-1111-1111-1111-111111111111"
RID = f"/subscriptions/{SID}/resourceGroups/test/providers/Microsoft.Network/networkSecurityGroups/nsg"
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def config_data():
    return json.loads((ROOT / "examples" / "config.example.json").read_text(encoding="utf-8"))


@pytest.fixture
def config(tmp_path, config_data):
    config_data["subscriptions"] = [SID]
    config_data["discovery_tables"] = ["Resources"]
    config_data["collections"] = {}
    p = tmp_path / "config.json"
    p.write_text(json.dumps(config_data), encoding="utf-8")
    return Config.load(p)


class MemoryArchive:
    def __init__(self):
        self.data = {}
        self.locked = False
        self.fail_writes = False

    def put(self, name, content):
        if self.fail_writes:
            raise BackupError("test storage outage")
        if name in self.data:
            raise BackupError("overwrite refused")
        self.data[name] = content

    def get(self, name):
        if name not in self.data:
            raise BackupError("missing blob")
        return self.data[name]

    def assert_lock(self):
        if not self.locked:
            raise BackupError("not locked")

    @contextmanager
    def guard(self, key):
        self.locked = True
        try:
            yield
        finally:
            self.locked = False


class MemoryEvents:
    def __init__(self):
        self.records = []
        self.flushes = 0
        self.fail_at = None

    def emit(self, event, **fields):
        self.records.append({"Event": event, **fields})

    def flush(self):
        self.flushes += 1
        if self.flushes == self.fail_at:
            raise BackupError("test log ingestion outage")


def nsg():
    return {
        "id": RID, "type": "Microsoft.Network/networkSecurityGroups", "location": "koreacentral",
        "tags": {"purpose": "test"},
        "properties": {
            "provisioningState": "Succeeded", "securityRules": [
                {"name": "https", "etag": "discard", "properties": {
                    "access": "Allow", "direction": "Inbound", "priority": 100,
                    "protocol": "Tcp", "sourceAddressPrefix": "10.0.0.0/8",
                    "sourcePortRange": "*", "destinationAddressPrefix": "*",
                    "destinationPortRange": "443", "provisioningState": "Succeeded",
                }}
            ], "defaultSecurityRules": [], "flushConnection": False,
        },
    }


class CaptureArm:
    def __init__(self):
        self.calls = []
        self.fail_capture = False
        self.arg_rows = [{"id": RID, "type": "microsoft.network/networksecuritygroups",
                          "resourceGroup": "test"}]
        self.arg_response = None
        self.responses = []

    def pages(self, path, api_version):
        self.calls.append(("LIST", path, api_version))
        if path == "/subscriptions":
            yield {"subscriptionId": SID, "state": "Enabled"}
        else:
            yield {"name": "child"}

    def request(self, method, path, api_version=None, body=None):
        self.calls.append((method, path, api_version, body))
        if self.responses:
            result = self.responses.pop(0)
            if isinstance(result, Exception):
                raise result
            return result
        if method == "POST":
            return self.arg_response or {
                "data": self.arg_rows, "count": len(self.arg_rows),
                "totalRecords": len(self.arg_rows), "resultTruncated": "false",
            }
        if self.fail_capture:
            raise BackupError("ARM HTTP 403: AuthorizationFailed")
        if "/providers/microsoft." in path.lower() and path.count("/") == 4:
            return {"resourceTypes": [{"resourceType": "virtualNetworks",
                                      "apiVersions": ["2024-01-01", "2026-01-01-preview"]}]}
        return nsg()
