from __future__ import annotations

import json
import sys
import threading
from collections.abc import MutableMapping
from typing import Any

from azure.core.credentials import TokenCredential
from azure.core.exceptions import AzureError
from azure.monitor.ingestion import LogsIngestionClient

from armbackup.config import Config
from armbackup.contracts import Arm, BackupError, JsonObject, object_value, utc_now

LOG_COLUMNS = {
    "TimeGenerated": "datetime", "RunId": "string", "Level": "string",
    "Event": "string", "ResourceId": "string", "Status": "string",
    "ErrorCode": "string", "Details": "dynamic",
}


def verify_log_destination(config: Config, arm: Arm) -> None:
    props = object_value(arm.request("GET", config.dcr_id, "2024-03-11").get("properties"),
                         "DCR properties")
    if props.get("immutableId") != config.logs_rule_id:
        raise BackupError("DCR immutableId does not match configured rule_id")
    declaration = object_value(
        object_value(props.get("streamDeclarations"), "DCR streams").get(config.logs_stream),
        "DCR input stream",
    )
    columns = declaration.get("columns")
    if not isinstance(columns, list) or {
        c.get("name"): c.get("type") for c in columns if isinstance(c, dict)
    } != LOG_COLUMNS:
        raise BackupError("DCR input columns do not match armbackup log schema")
    targets = object_value(props.get("destinations"), "DCR destinations").get("logAnalytics", [])
    if not isinstance(targets, list):
        raise BackupError("DCR Log Analytics destinations must be an array")
    names = {
        t.get("name") for t in targets if isinstance(t, dict)
        and str(t.get("workspaceResourceId", "")).lower() == config.workspace_id.lower()
    }
    flows = props.get("dataFlows")
    matches = [
        f for f in flows if isinstance(f, dict) and config.logs_stream in f.get("streams", [])
    ] if isinstance(flows, list) else []
    if not matches or any(
        not f.get("destinations") or not set(f["destinations"]) <= names
        or f.get("transformKql", "source").strip() != "source"
        for f in matches
    ):
        raise BackupError("DCR stream must route unchanged only to the designated workspace")
    endpoints = object_value(props.get("endpoints", {}), "DCR endpoints")
    expected = endpoints.get("logsIngestion")
    if config.logs_endpoint != str(expected).rstrip("/"):
        dce_id = props.get("dataCollectionEndpointId")
        if not isinstance(dce_id, str):
            raise BackupError("Logs endpoint is neither the DCR endpoint nor its linked DCE")
        dce = object_value(arm.request("GET", dce_id, "2023-03-11").get("properties"),
                           "DCE properties")
        expected = object_value(dce.get("logsIngestion"), "DCE logsIngestion").get("endpoint")
        if config.logs_endpoint != str(expected).rstrip("/"):
            raise BackupError("Configured ingestion endpoint does not match linked DCE")


class LogAnalyticsEvents:
    def __init__(self, config: Config, credential: TokenCredential, run_id: str) -> None:
        self.config = config
        self.run_id = run_id
        self.client = LogsIngestionClient(
            endpoint=config.logs_endpoint, credential=credential,
            retry_total=config.retries, connection_timeout=10, read_timeout=config.timeout,
        )
        self.buffer: list[JsonObject] = []
        self.lock = threading.Lock()

    def emit(
        self, event: str, *, level: str = "Information", resource_id: str = "",
        status: str = "", code: str = "", **metrics: int | float | str,
    ) -> None:
        record: JsonObject = {
            "TimeGenerated": utc_now(), "RunId": self.run_id, "Level": level,
            "Event": event, "ResourceId": resource_id, "Status": status,
            "ErrorCode": code, "Details": metrics,
        }
        with self.lock:
            print(json.dumps(record, ensure_ascii=False), flush=True)
            self.buffer.append(record)
            if len(self.buffer) >= 100:
                self._flush()

    def _flush(self) -> None:
        if not self.buffer:
            return
        payload: list[MutableMapping[str, Any]] = [record for record in self.buffer]
        try:
            self.client.upload(
                rule_id=self.config.logs_rule_id, stream_name=self.config.logs_stream,
                logs=payload,
            )
        except AzureError as exc:
            print(json.dumps({"Event": "log_ingestion_failed", "RunId": self.run_id,
                              "ErrorCode": type(exc).__name__}), file=sys.stderr, flush=True)
            raise BackupError(f"Log Analytics ingestion failed: {type(exc).__name__}") from exc
        self.buffer.clear()

    def flush(self) -> None:
        with self.lock:
            self._flush()
