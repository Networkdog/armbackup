from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from armbackup.config import TABLES, Config, version
from armbackup.contracts import Arm, BackupError, Events, JsonObject, object_value

ARG_VERSION = "2024-04-01"
PROVIDER_VERSION = "2021-04-01"


def management_groups(arm: Arm, subscription: str) -> list[JsonObject]:
    result = arm.request("POST", "/providers/Microsoft.ResourceGraph/resources", ARG_VERSION, {
        "subscriptions": [subscription],
        "query": "ResourceContainers | where type =~ 'microsoft.resources/subscriptions' "
                 "| project id, ancestors=properties.managementGroupAncestorsChain",
        "options": {"$top": 1000, "resultFormat": "objectArray", "allowPartialScopes": False},
    })
    rows = result.get("data")
    if (not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict)
            or str(rows[0].get("id", "")).lower() != f"/subscriptions/{subscription}".lower()
            or not isinstance(rows[0].get("ancestors"), list)
            or result.get("$skipToken") or str(result.get("resultTruncated")).lower() == "true"):
        raise BackupError("Management group ancestry could not be verified from Resource Graph")
    scopes: list[JsonObject] = []
    parent = None
    for raw in reversed(rows[0]["ancestors"]):
        group = object_value(raw, "management group ancestor")
        name, display = group.get("name"), group.get("displayName")
        if (not isinstance(name, str) or not name or "/" in name
                or any(char in name for char in "?%#\\")
                or not isinstance(display, str) or not display):
            raise BackupError("Management group ancestor identity is invalid")
        identifier = "/providers/Microsoft.Management/managementGroups/" + name
        if any(scope["id"].lower() == identifier.lower() for scope in scopes):
            raise BackupError("Management group ancestry contains a cycle")
        scopes.append({"id": identifier, "kind": "managementGroup", "name": display,
                       "detail": name, "parentId": parent})
        parent = identifier
    return scopes


@dataclass(frozen=True)
class Resource:
    id: str
    type: str
    subscription: str
    group: str

    @classmethod
    def parse(cls, row: JsonObject, subscription: str) -> Resource:
        rid, rtype = row.get("id"), row.get("type")
        if not isinstance(rid, str) or not isinstance(rtype, str):
            raise BackupError("ARG row missing id/type")
        prefix = f"/subscriptions/{subscription}"
        if not (rid.lower() == prefix.lower() or rid.lower().startswith(prefix.lower() + "/")):
            raise BackupError("ARG returned resource outside requested subscription")
        parsed = urlsplit(rid)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            raise BackupError("ARG returned invalid resource ID")
        return cls(rid, rtype.lower(), subscription, str(row.get("resourceGroup", "")).lower())


def subscriptions(arm: Arm, config: Config) -> tuple[list[str], list[JsonObject]]:
    available = list(arm.pages("/subscriptions", "2022-12-01"))
    enabled: dict[str, str] = {}
    excluded: list[JsonObject] = []
    for sub in available:
        sid, state = sub.get("subscriptionId"), sub.get("state")
        if not isinstance(sid, str):
            raise BackupError("Subscription response missing subscriptionId")
        if state == "Enabled":
            enabled[sid.lower()] = sid
        else:
            excluded.append({"subscriptionId": sid, "reason": f"State:{state}"})
    if config.subscriptions:
        missing = [sid for sid in config.subscriptions if sid.lower() not in enabled]
        if missing:
            raise BackupError("Configured subscription unavailable or disabled: " + ",".join(missing))
        return [enabled[s.lower()] for s in config.subscriptions], excluded
    if not enabled:
        raise BackupError("No accessible enabled subscriptions")
    return sorted(enabled.values()), excluded


def discover(
    arm: Arm, config: Config, scope: list[str], events: Events,
) -> tuple[list[Resource], list[JsonObject]]:
    resources: dict[str, Resource] = {}
    failures: list[JsonObject] = []
    for subscription in scope:
        for table in config.tables:
            query = (
                table + TABLES[table]
                + " | where id startswith '/subscriptions/'"
            )
            if config.resource_groups:
                groups = ", ".join("'" + group.replace("\\", "\\\\").replace("'", "\\'") + "'"
                                   for group in config.resource_groups)
                query += f" | where resourceGroup in~ ({groups}) or type =~ 'microsoft.resources/subscriptions'"
            query += " | project id, type, resourceGroup | order by id asc"
            token: str | None = None
            seen: set[str] = set()
            ids: set[str] = set()
            expected: int | None = None
            try:
                for _ in range(10000):
                    options: JsonObject = {
                        "$top": 1000, "resultFormat": "objectArray", "allowPartialScopes": False,
                    }
                    if token:
                        options["$skipToken"] = token
                    result = arm.request("POST", "/providers/Microsoft.ResourceGraph/resources",
                                         ARG_VERSION,
                                         {"subscriptions": [subscription], "query": query,
                                          "options": options})
                    rows, total = result.get("data"), result.get("totalRecords")
                    if not isinstance(rows, list) or type(total) is not int or total < 0:
                        raise BackupError("Invalid ARG response shape")
                    if expected is not None and total != expected:
                        raise BackupError("ARG inventory changed during pagination")
                    expected = total
                    for row in rows:
                        resource = Resource.parse(object_value(row, "ARG row"), subscription)
                        key = resource.id.lower()
                        if key in ids:
                            raise BackupError("ARG pagination returned duplicate resource")
                        ids.add(key)
                        if key in resources and resources[key].type != resource.type:
                            raise BackupError("ARG resource type conflict across tables")
                        resources[key] = resource
                    next_token = result.get("$skipToken")
                    truncated = result.get("resultTruncated")
                    if next_token is not None:
                        if not isinstance(next_token, str) or not next_token or next_token in seen:
                            raise BackupError("Invalid or repeated ARG skip token")
                        seen.add(next_token)
                        token = next_token
                        continue
                    if str(truncated).lower() == "true" or len(ids) != expected:
                        raise BackupError("ARG results incomplete without continuation token")
                    break
                else:
                    raise BackupError("ARG pagination limit exceeded")
                events.emit("discovery_complete", status="Succeeded",
                            subscription=subscription, table=table, count=len(ids))
            except BackupError as exc:
                failures.append({"subscriptionId": subscription, "table": table, "error": str(exc)})
                events.emit("discovery_failed", level="Error", status="Failed",
                            code=type(exc).__name__, subscription=subscription, table=table)
    if "ResourceContainers" in config.tables:
        for subscription in scope:
            if f"/subscriptions/{subscription}".lower() not in resources:
                failures.append({"subscriptionId": subscription, "table": "ResourceContainers",
                                 "error": "Expected subscription container missing from ARG"})
                events.emit("subscription_container_missing", level="Error", status="Failed",
                            subscription=subscription)
    return sorted(resources.values(), key=lambda r: r.id.lower()), failures


class ApiResolver:
    def __init__(self, arm: Arm, config: Config) -> None:
        self.arm = arm
        self.config = config
        self.providers: dict[tuple[str, str], JsonObject] = {}

    def resolve(self, resource: Resource) -> str:
        if resource.type in self.config.api_versions:
            return self.config.api_versions[resource.type]
        if resource.type == "microsoft.resources/subscriptions":
            return "2022-12-01"
        if resource.type == "microsoft.resources/subscriptions/resourcegroups":
            return "2021-04-01"
        if "/" not in resource.type:
            raise BackupError("Invalid resource type")
        namespace, name = resource.type.split("/", 1)
        key = (resource.subscription.lower(), namespace)
        if key not in self.providers:
            self.providers[key] = self.arm.request(
                "GET", f"/subscriptions/{resource.subscription}/providers/{namespace}",
                PROVIDER_VERSION,
            )
        types = self.providers[key].get("resourceTypes")
        if not isinstance(types, list):
            raise BackupError("Provider metadata missing resourceTypes")
        for entry in types:
            item = object_value(entry, "resource type")
            if str(item.get("resourceType", "")).lower() != name:
                continue
            values = item.get("apiVersions")
            if not isinstance(values, list):
                raise BackupError("Provider metadata missing apiVersions")
            candidates = [
                version(v, preview=self.config.allow_preview) for v in values
                if isinstance(v, str) and (self.config.allow_preview or not v.endswith("-preview"))
            ]
            if candidates:
                return max(candidates)
        raise BackupError("No supported capture API found; configure a tested override")
