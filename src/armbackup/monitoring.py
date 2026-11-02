from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import requests
from azure.core.credentials import TokenCredential

from armbackup.config import UUID
from armbackup.contracts import Arm, BackupError, JsonObject, object_value
from armbackup.http import error_code


def kql_literal(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'").replace("\r", "\\r").replace("\n", "\\n") + "'"


class LogsReader:
    def __init__(self, credential: TokenCredential, workspace_guid: str, scope: str) -> None:
        if not UUID.fullmatch(workspace_guid):
            raise BackupError("Log query requires the configured workspace GUID, not its ARM ID")
        self.credential, self.workspace_guid, self.scope = credential, workspace_guid, scope

    def query(self, *, days: int = 7, level: str = "", search: str = "") -> JsonObject:
        if (type(days) is not int or days not in {1, 7, 30}
                or not isinstance(level, str) or level not in {"", "Information", "Warning", "Error"}):
            raise BackupError("Unsupported log period or level")
        if not isinstance(search, str) or len(search) > 200:
            raise BackupError("Log search must be at most 200 characters")
        query = [
            "ArmBackup_CL", f"| where TimeGenerated > ago({days}d)",
            f"| where ResourceId startswith {kql_literal(self.scope + '/')} or tostring(Details.scope) =~ {kql_literal(self.scope)} or tostring(Details.scope) startswith {kql_literal(self.scope + '/')}",
        ]
        if level:
            query.append(f"| where Level == {kql_literal(level)}")
        if search:
            text = kql_literal(search)
            query.append(f"| where Event contains {text} or ResourceId contains {text} or RunId contains {text} or tostring(Details) contains {text}")
        query.extend([
            "| order by TimeGenerated desc",
            "| project TimeGenerated, Level, Event, ResourceId, RunId, Status, ErrorCode, Details",
            "| take 200",
        ])
        statement = "\n".join(query)
        names = ["TimeGenerated", "Level", "Event", "ResourceId", "RunId", "Status", "ErrorCode", "Details"]
        rows = self._rows(statement, names)
        logs = []
        for index, item in enumerate(rows):
            raw_details = item.get("Details")
            if isinstance(raw_details, str):
                try:
                    raw_details = json.loads(raw_details)
                except ValueError as exc:
                    raise BackupError("Log dynamic Details is not valid JSON") from exc
            details = object_value(raw_details if raw_details is not None else {}, "log details")
            logs.append({
                "id": f"log-{index}", "time": item["TimeGenerated"], "level": item["Level"],
                "event": item["Event"], "resourceId": item["ResourceId"], "runId": item["RunId"],
                "status": item["Status"], "code": item["ErrorCode"], "details": details,
                "correlationId": details.get("correlationId", ""),
                "ticket": details.get("ticket", ""), "source": "Log Analytics · ArmBackup_CL",
            })
        return {"source": "log-analytics", "logs": logs, "query": statement,
                "limit": 200, "limitReached": len(logs) == 200}

    def gateway(self, resource_id: str) -> JsonObject:
        from armbackup.resource_profiles import AGW, arm_identity

        prefix = self.scope + ("/resourceGroups/" if self.scope.lower().count("/") == 2 else "/providers/")
        if (not resource_id.lower().startswith(prefix.lower())
                or arm_identity(resource_id)[0] != AGW):
            raise BackupError("Gateway diagnostics must stay inside the configured scope")
        scope = f"| where TimeGenerated > ago(24h) and _ResourceId =~ {kql_literal(resource_id)}"
        statement = "\n".join([
            "union",
            f"(AGWFirewallLogs {scope}",
            '| extend TriagePriority=iif(Action == "Blocked", 0, 1)',
            '| order by TriagePriority asc, TimeGenerated desc | take 100',
            '| project TimeGenerated, Category="WAF", Status=Action, Detail=Message, RuleId, TransactionId),',
            f"(AGWAccessLogs {scope}",
            '| order by TimeGenerated desc | take 100',
            '| project TimeGenerated, Category="Access", Status=tostring(HttpStatus), Detail=ErrorInfo, RuleId="", TransactionId)',
            "| order by TimeGenerated desc | take 200",
        ])
        rows = self._rows(statement, ["TimeGenerated", "Category", "Status", "Detail", "RuleId", "TransactionId"])
        return {"source": "log-analytics", "logs": rows, "query": statement,
                "limit": 200, "limitReached": len(rows) == 200, "hours": 24,
                "perCategoryLimit": 100}

    def _rows(self, statement: str, expected_columns: list[str]) -> list[JsonObject]:
        token = self.credential.get_token("https://api.loganalytics.io/.default").token
        try:
            response = requests.post(
                f"https://api.loganalytics.azure.com/v1/workspaces/{self.workspace_guid}/query",
                headers={"Authorization": f"Bearer {token}"}, json={"query": statement},
                timeout=(10, 60), allow_redirects=False,
            )
        except (requests.Timeout, requests.ConnectionError) as exc:
            raise BackupError(f"Log query transport failed: {type(exc).__name__}") from exc
        if response.status_code != 200:
            raise BackupError(f"Log query HTTP {response.status_code}: {error_code(response)}")
        try:
            data = object_value(response.json(), "log query")
        except ValueError as exc:
            raise BackupError("Log query returned invalid JSON") from exc
        if data.get("error"):
            raise BackupError("Log query returned a partial error; results are not complete")
        tables = data.get("tables")
        if not isinstance(tables, list) or not tables:
            raise BackupError("Log query response is missing its result table")
        table = object_value(tables[0], "log query table")
        columns, rows = table.get("columns"), table.get("rows")
        if not isinstance(columns, list) or not isinstance(rows, list) or len(rows) > 200:
            raise BackupError("Invalid log query result")
        names = [str(object_value(column, "log column").get("name", "")) for column in columns]
        if names != expected_columns:
            raise BackupError("Log query schema differs from configured ingestion schema")
        result = []
        for row in rows:
            if not isinstance(row, list) or len(row) != len(names):
                raise BackupError("Invalid log result row")
            result.append(dict(zip(names, row, strict=True)))
        return result


def activity_changes(
    arm: Arm, subscription: str, resource_group: str, *, days: int = 2,
) -> dict[str, JsonObject]:
    start = (datetime.now(UTC) - timedelta(days=days)).isoformat().replace("+00:00", "Z")
    query = urlencode({"$filter": f"eventTimestamp ge '{start}' and resourceGroupName eq '{resource_group}'"})
    path = f"/subscriptions/{subscription}/providers/Microsoft.Insights/eventtypes/management/values?{query}"
    result: dict[str, JsonObject] = {}
    for count, item in enumerate(arm.pages(path, "2015-04-01")):
        if count >= 2000:
            raise BackupError("Activity Log exceeds the 2,000-event limit; narrow the configured period")
        operation = str(object_value(item.get("operationName", {}), "activity operation").get("value", "")).lower()
        status = object_value(item.get("status", {}), "activity status").get("value", "")
        resource_id, at = item.get("resourceId"), item.get("eventTimestamp")
        if (status != "Succeeded" or not operation.endswith(("/write", "/delete"))
                or not isinstance(resource_id, str) or not isinstance(at, str)):
            continue
        key = resource_id.lower()
        if key not in result or at > result[key]["at"]:
            result[key] = {"caller": item.get("caller") or "호출 주체 미확인", "at": at,
                           "operation": operation, "correlationId": item.get("correlationId", ""),
                           "eventResourceId": resource_id,
                           "source": "Azure Activity Log", "attribution": "latest-successful-management-operation"}
    return result


def resource_actor(
    actors: dict[str, JsonObject], resource_id: str, resource_type: str,
) -> JsonObject | None:
    children = {"microsoft.network/networksecuritygroups": "securityRules",
                "microsoft.network/routetables": "routes",
                "microsoft.network/virtualnetworks": "subnets"}
    key = resource_id.lower()
    child = children.get(resource_type)
    candidates = [actor for identifier, actor in actors.items()
                  if identifier == key or (child and identifier.startswith(key + "/" + child.lower() + "/"))]
    return max(candidates, key=lambda actor: str(actor["at"])) if candidates else None
