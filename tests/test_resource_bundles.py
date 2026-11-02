import copy
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from conftest import MemoryEvents
from test_console import GROUP, RID, RUN, SCOPE, SID, LabArm, expand_subscription

from armbackup.backup import Backup
from armbackup.bundle_console import BundleConsole
from armbackup.change_history import descriptor
from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import ArmHttpError, BackupError, digest, encode_json
from armbackup.discovery import Resource
from armbackup.local_archive import LocalArchive
from armbackup.monitoring import LogsReader
from armbackup.resource_bundles import bundle_definition, restore_order, topology
from armbackup.resource_profiles import (
    AFD,
    AFD_ENDPOINT,
    AFD_ORIGIN,
    AFD_ORIGIN_GROUP,
    AFD_ROUTE,
    AFD_RULE,
    AFD_RULESET,
    AGW,
    LB,
    LB_POOL,
    PIP,
    PROFILE_APIS,
    WAF,
    arm_identity,
    configuration_body,
    ownership_parent,
    restore_body,
)

RUN2 = "20261031T060000Z-000000000001"
TAGS = {"armbackupLab": "unit-lab", "armbackupWorkload": "true"}


def resource(kind, name, properties):
    parts = kind.split("/")
    identifier = SCOPE + "/providers/" + parts[0] + "/" + parts[1] + "/" + name
    return {"id": identifier, "name": name, "type": kind, "location": "koreacentral",
            "tags": copy.deepcopy(TAGS), "properties": copy.deepcopy(properties)}


def envelope(raw):
    return {"resourceId": raw["id"], "resourceType": arm_identity(raw["id"])[0],
            "captureApiVersion": PROFILE_APIS[arm_identity(raw["id"])[0]], "raw": raw}


def lb_resources():
    lb = resource(LB, "load-balancer", {})
    pool_id = lb["id"] + "/backendAddressPools/http"
    pool = {"id": pool_id, "name": "http", "type": LB_POOL,
            "properties": {"loadBalancerBackendAddresses": [
                {"name": "server", "properties": {"ipAddress": "10.1.0.4"}},
            ]}}
    lb["properties"]["backendAddressPools"] = [copy.deepcopy(pool)]
    lb["properties"]["loadBalancingRules"] = [{
        "name": "http", "properties": {"frontendPort": 8080, "backendPort": 80,
                                       "protocol": "Tcp", "backendAddressPool": {"id": pool_id}},
    }]
    return lb, pool


class BundleArm(LabArm):
    def pages(self, path, api_version):
        if path.endswith("/backendAddressPools"):
            yield from [copy.deepcopy(raw) for raw in self.resources.values()
                        if raw["id"].lower().startswith(path.lower() + "/")]
        elif "/profiles/" in path and not path.endswith("/resources"):
            yield from [copy.deepcopy(raw) for raw in self.resources.values()
                        if raw["id"].rsplit("/", 1)[0].lower() == path.lower()]
        else:
            yield from super().pages(path, api_version)

    def request(self, method, path, api_version=None, body=None):
        if method != "PUT":
            return super().request(method, path, api_version, body)
        self.calls.append((method, path, api_version, copy.deepcopy(body)))
        kind, name, parent = arm_identity(path)
        if kind == AFD_ROUTE:
            group = body["properties"]["originGroup"]["id"].lower()
            if not any(raw["type"] == AFD_ORIGIN and raw["id"].rsplit("/", 2)[0].lower() == group
                       and raw["properties"].get("enabledState", "Enabled") == "Enabled"
                       for raw in self.resources.values()):
                raise ArmHttpError(400, "BadRequest")
        raw = {**copy.deepcopy(body), "id": path, "name": name, "type": kind}
        raw.setdefault("properties", {})["provisioningState"] = "Succeeded"
        if kind == LB:
            for pool in raw["properties"].get("backendAddressPools", []):
                pool["properties"]["loadBalancerBackendAddresses"] = []
                child_id = path + "/backendAddressPools/" + pool["name"]
                child_key = child_id.lower()
                if child_key not in self.resources:
                    self.resources[child_key] = {**copy.deepcopy(pool), "id": child_id,
                                                 "type": LB_POOL}
                self.resources[child_key]["etag"] = "parent-update"
        self.resources[path.lower()] = raw
        if kind == LB_POOL:
            root = self.resources[parent.lower()]
            root["properties"]["backendAddressPools"] = [copy.deepcopy(raw)]
        return copy.deepcopy(raw)


@pytest.fixture
def console(tmp_path, config):
    capture = replace(config, resource_groups=(GROUP,), collections={}, api_versions=PROFILE_APIS)
    settings = ConsoleConfig(capture, "Unit", "LAB", "unit-lab", SID, True, 2,
                             "local", tmp_path / "archive", "lab")
    arm, archive, events = BundleArm(), LocalArchive(settings.local_archive), MemoryEvents()
    client = LiveConsole(settings, arm, archive, lambda _: events, Mock(spec=LogsReader))
    Backup(capture, arm, archive, events).run(RUN, inventory=[Resource(RID, arm_identity(RID)[0], SID, GROUP)])
    try:
        yield client
    finally:
        client.close()


def capture(console, raws):
    for raw in raws:
        console.arm.resources[raw["id"].lower()] = copy.deepcopy(raw)
    metadata = {raw["id"].lower(): {"tags": TAGS, "ownershipParent": ownership_parent(raw["id"]) or ""}
                for raw in raws}
    result = Backup(console.config.capture, console.arm, console.archive, console.events_factory("test")).run(
        RUN2, inventory=[console.config.resource(raw["id"]) for raw in raws], resource_metadata=metadata,
    )
    assert result["status"] == "Captured", result["captureFailures"]


def review(console, ids=None, run=RUN, mode="update", **extra):
    return console.bundle_review({
        "resourceIds": ids or [RID], "runId": run, "mode": mode, "includeRelated": False,
        "ticket": "INC-1234", "reason": "Approved isolated recovery exercise",
        "acknowledgeExternal": True, **extra,
    })


def execute(console, plan, job=None, **extra):
    return console.bundle_restore(job if job is not None else {"id": "unit-operation", "writeAttempted": False}, {
        "planId": plan["id"], "approvalSha256": plan["approvalSha256"],
        "confirmGroup": GROUP, **extra,
    })


def test_subscription_bundle_without_lab_tags_can_update_clone_and_recreate_across_groups(console):
    other_id = expand_subscription(console)
    console.arm.resources[RID.lower()]["tags"] = {}
    raw_ids = [RID, other_id]
    saved = console.bundle_backup({"id": "subscription-backup"}, {
        "resourceIds": raw_ids, "includeRelated": False,
    })
    for identifier in raw_ids:
        console.arm.resources[identifier.lower()]["tags"]["drift"] = "true"
    plan = review(console, ids=raw_ids, run=saved["runId"])
    with pytest.raises(BackupError, match="confirmation"):
        execute(console, plan)
    result = execute(console, plan, confirmGroup=SID)
    assert result["status"] == "Succeeded"
    assert all("drift" not in console.arm.resources[identifier.lower()]["tags"] for identifier in raw_ids)
    assert console.read_run(result["safetyRunId"])["verified"]
    clone = review(console, ids=raw_ids, run=saved["runId"], mode="clone", clonePrefix="copy")
    copied = execute(console, clone, confirmGroup=SID)
    assert copied["status"] == "Succeeded"
    assert all(action["resourceId"].lower() in console.arm.resources for action in clone["actions"])
    for identifier in raw_ids:
        del console.arm.resources[identifier.lower()]
    recreate = review(console, ids=raw_ids, run=saved["runId"], mode="create")
    created = execute(console, recreate, confirmGroup=SID)
    assert created["status"] == "Succeeded"
    assert all(identifier.lower() in console.arm.resources for identifier in raw_ids)


def test_subscription_restore_still_blocks_other_subscriptions_before_writing(console):
    expand_subscription(console)
    foreign = RID.replace(SID, "22222222-2222-2222-2222-222222222222")
    with pytest.raises(BackupError, match="outside the configured subscription"):
        review(console, ids=[foreign])
    assert not [call for call in console.arm.calls if call[0] == "PUT"]


def test_subscription_shared_reference_can_be_read_in_another_group_without_lab_tags(console):
    other_id = expand_subscription(console)
    result = BundleConsole(console)._external({"referenceId": other_id, "ownershipRequired": True})
    assert result["id"] == other_id
    assert result["readOnly"]
    foreign = other_id.replace(SID, "22222222-2222-2222-2222-222222222222")
    with pytest.raises(BackupError, match="outside the configured subscription"):
        BundleConsole(console)._external({"referenceId": foreign})


def test_single_update_has_verified_preimage_and_one_shot_claim(console):
    before = copy.deepcopy(console.arm.resources[RID.lower()])
    console.arm.resources[RID.lower()]["tags"]["owner"] = "changed"
    safety_before = copy.deepcopy(console.arm.resources[RID.lower()])
    plan = review(console)
    result = execute(console, plan)
    safety = console.read_run(result["safetyRunId"])
    assert safety["verified"] and safety["envelopes"][0]["raw"] == safety_before
    assert console.arm.resources[RID.lower()]["tags"] == before["tags"]
    with pytest.raises(BackupError, match="already submitted"):
        execute(console, plan)


def test_clone_creates_new_owned_target_and_preserves_original(console):
    original = copy.deepcopy(console.arm.resources[RID.lower()])
    plan = review(console, mode="clone", clonePrefix="twin")
    assert plan["actions"][0]["sourceResourceId"] == RID
    target = plan["actions"][0]["resourceId"]
    assert target != RID and target.endswith("/twin-nsg-unit")
    result = execute(console, plan)
    assert result["resourceIds"] == [target]
    assert console.arm.resources[RID.lower()] == original
    assert console.read_run(result["safetyRunId"])["manifest"]["absences"][0]["resourceId"] == target
    with pytest.raises(BackupError, match="target exists"):
        review(console, mode="clone", clonePrefix="twin")


def test_clone_does_not_rewrite_opaque_arm_id_tag_values():
    from armbackup.resource_bundles import clone_targets

    raw = resource(PIP, "public", {"publicIPAllocationMethod": "Static"})
    raw["tags"]["reference-note"] = raw["id"]
    graph = topology([envelope(raw)])
    body = clone_targets(graph, [raw["id"]], "twin")[raw["id"].lower()]["body"]
    assert body["tags"]["reference-note"] == raw["id"]


def test_derived_pip_fqdn_is_not_replayed_and_arm_reference_casing_is_not_drift():
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static",
        "dnsSettings": {"domainNameLabel": "source", "fqdn": "source.example.test"}})
    assert "fqdn" not in restore_body(pip, PIP)["properties"]["dnsSettings"]
    agw = resource(AGW, "gateway", {"firewallPolicy": {"id":
        SCOPE + "/providers/Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies/policy"}})
    other = copy.deepcopy(agw)
    other["properties"]["firewallPolicy"]["id"] = other["properties"]["firewallPolicy"]["id"].lower()
    assert configuration_body(agw, AGW) == configuration_body(other, AGW)


def test_clone_remaps_gateway_self_ids_policy_and_pip_but_keeps_shared_backend():
    from armbackup.resource_bundles import clone_targets

    waf = resource(WAF, "policy", {"managedRules": {"managedRuleSets": [
        {"ruleSetType": "OWASP", "ruleSetVersion": "3.2"}]}})
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static", "dnsSettings": {"domainNameLabel": "original"}})
    agw = resource(AGW, "gateway", {"firewallPolicy": {"id": waf["id"]},
        "gatewayIPConfigurations": [{"name": "net", "properties": {"subnet": {"id": SCOPE + "/providers/Microsoft.Network/virtualNetworks/shared/subnets/gateway"}}}],
        "frontendPorts": [{"name": "http", "properties": {"port": 80}}],
        "httpListeners": [{"name": "http", "properties": {"frontendPort": {"id": SCOPE + "/providers/microsoft.network/applicationgateways/gateway/frontendPorts/http"}}}],
        "frontendIPConfigurations": [{"name": "public", "properties": {"publicIPAddress": {"id": pip["id"]}}}],
        "backendAddressPools": [{"name": "http", "properties": {"backendAddresses": [{"ipAddress": "10.1.0.4"}]}}]})
    graph = topology([envelope(agw), envelope(waf), envelope(pip)])
    mapped = clone_targets(graph, [agw["id"], waf["id"], pip["id"]], "twin")
    props = mapped[agw["id"].lower()]["body"]["properties"]
    assert props["firewallPolicy"]["id"] == mapped[waf["id"].lower()]["resourceId"]
    assert props["frontendIPConfigurations"][0]["properties"]["publicIPAddress"]["id"] == mapped[pip["id"].lower()]["resourceId"]
    assert "/twin-gateway/frontendPorts/http" in props["httpListeners"][0]["properties"]["frontendPort"]["id"]
    assert props["backendAddressPools"][0]["properties"]["backendAddresses"][0]["ipAddress"] == "10.1.0.4"
    assert mapped[pip["id"].lower()]["body"]["properties"]["dnsSettings"]["domainNameLabel"] == "twin-original"
    with pytest.raises(BackupError, match="prefix"):
        clone_targets(graph, [agw["id"]], "../unsafe")


def test_absent_target_recreation_records_absence_not_a_fake_snapshot(console):
    del console.arm.resources[RID.lower()]
    plan = review(console, mode="create")
    result = execute(console, plan)
    safety = console.read_run(result["safetyRunId"])
    assert safety["verified"] and not safety["envelopes"]
    assert safety["manifest"]["absences"][0]["resourceId"] == RID


@pytest.mark.parametrize("mode,missing", [("create", False), ("update", True)])
def test_modes_never_upsert(console, mode, missing):
    if missing:
        del console.arm.resources[RID.lower()]
    with pytest.raises(BackupError, match="target"):
        review(console, mode=mode)


@pytest.mark.parametrize("extra", [{"ticket": "x"}, {"reason": "x"}, {"includeRelated": "yes"},
                                  {"resourceIds": []}, {"resourceIds": [RID.replace(GROUP, "outside")]}])
def test_review_validation(console, extra):
    with pytest.raises(BackupError):
        review(console, **extra)


def test_target_drift_after_review_stops_before_any_write(console):
    plan = review(console)
    console.arm.resources[RID.lower()]["tags"]["owner"] = "after-review"
    with pytest.raises(BackupError, match="changed after review"):
        execute(console, plan)
    assert not any(call[0] == "PUT" for call in console.arm.calls)


@pytest.mark.parametrize("writable_change", [False, True])
def test_related_policy_write_can_change_gateway_etag_but_not_its_reviewed_settings(console, writable_change):
    policy = resource(WAF, "policy", {"managedRules": {"managedRuleSets": [
        {"ruleSetType": "OWASP", "ruleSetVersion": "3.2"}]}})
    gateway = resource(AGW, "gateway", {"firewallPolicy": {"id": policy["id"]}})
    capture(console, [policy, gateway])
    plan = review(console, [gateway["id"]], RUN2, includeRelated=True)
    original = console.arm.request

    def related_write(method, path, api_version=None, body=None):
        result = original(method, path, api_version, body)
        if method == "PUT" and path == policy["id"]:
            console.arm.resources[gateway["id"].lower()]["etag"] = "related-policy-write"
            if writable_change:
                console.arm.resources[gateway["id"].lower()]["tags"]["unexpected"] = "external-change"
        return result

    with patch.object(console.arm, "request", side_effect=related_write):
        if writable_change:
            with pytest.raises(BackupError, match="changed before write"):
                execute(console, plan)
        else:
            assert len(execute(console, plan)["resourceIds"]) == 2


def test_safety_storage_failure_stops_before_any_write(console):
    plan = review(console)
    with patch.object(console.archive, "put", side_effect=BackupError("Storage unavailable")):
        with pytest.raises(BackupError, match="Storage unavailable"):
            execute(console, plan)
    assert not any(call[0] == "PUT" for call in console.arm.calls)


def test_wrong_group_or_hash_stops_before_claim(console):
    plan = review(console)
    for extra in ({"confirmGroup": "outside"}, {"approvalSha256": "bad"}):
        with pytest.raises(BackupError, match="confirmation mismatch"):
            execute(console, plan, **extra)
    assert not console.archive.names("console/bundle-claims")


def test_api_change_and_removed_workload_ownership_are_not_reinterpreted_as_safe(console):
    plan = review(console)
    console.config.capture.api_versions[arm_identity(RID)[0]] = "2099-01-01"
    with pytest.raises(BackupError, match="API configuration changed"):
        execute(console, plan)
    console.config.capture.api_versions[arm_identity(RID)[0]] = "2024-05-01"
    console.arm.resources[RID.lower()]["tags"]["armbackupWorkload"] = "false"
    with pytest.raises(BackupError, match="no longer an approved workload"):
        review(console)


def test_safety_log_failure_does_not_create_a_completion_marker_or_write(console):
    plan = review(console)
    events = console.events_factory("test")
    events.fail_at = events.flushes + 1
    with pytest.raises(BackupError, match="log ingestion"):
        execute(console, plan)
    assert not any(call[0] == "PUT" for call in console.arm.calls)


def test_backend_address_response_fields_are_not_blindly_stripped_outside_own_pool():
    lb, _ = lb_resources()
    pool = lb["properties"]["backendAddressPools"][0]
    address = pool["properties"]["loadBalancerBackendAddresses"][0]
    address["id"] = pool["id"] + "/loadBalancerBackendAddresses/server"
    address["type"] = LB_POOL + "/loadBalancerBackendAddresses"
    address["etag"] = "readonly"
    address["properties"]["provisioningState"] = "Succeeded"
    projected = restore_body(lb, LB)["properties"]["backendAddressPools"][0]["properties"]["loadBalancerBackendAddresses"][0]
    assert "id" not in projected and "provisioningState" not in projected["properties"]
    address["id"] = SCOPE + "/providers/Microsoft.Network/unknown/outside"
    with pytest.raises(BackupError, match="outside its captured pool"):
        restore_body(lb, LB)


def test_embedded_lb_references_do_not_create_a_parent_child_cycle():
    lb, pool = lb_resources()
    graph = topology([envelope(lb), envelope(pool)])
    definition = bundle_definition(graph, [lb["id"]], include_related=False)
    assert definition["resourceIds"] == [lb["id"], pool["id"]]
    assert graph["addresses"][0]["automaticRestore"] is False


def test_realistic_lb_root_put_ignores_addresses_but_child_put_then_final_verification_succeeds(console):
    lb, pool = lb_resources()
    capture(console, [lb, pool])
    del console.arm.resources[lb["id"].lower()]
    del console.arm.resources[pool["id"].lower()]
    plan = review(console, [lb["id"]], RUN2, "create")
    assert len(plan["actions"]) == 2 and plan["addressDependencies"]
    result = execute(console, plan)
    assert result["resourceIds"] == [lb["id"], pool["id"]]
    assert console.arm.resources[lb["id"].lower()]["properties"]["backendAddressPools"][0]["properties"]["loadBalancerBackendAddresses"]
    assert console.read_run(result["safetyRunId"])["verified"]


def test_related_owned_dependencies_are_opt_in_and_shared_fingerprint_is_checked(console):
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static"})
    lb = resource(LB, "load-balancer", {"frontendIPConfigurations": [
        {"name": "public", "properties": {"publicIPAddress": {"id": pip["id"]}}},
    ]})
    capture(console, [lb, pip])
    graph = topology([envelope(lb), envelope(pip)])
    assert bundle_definition(graph, [lb["id"]], include_related=False)["resourceIds"] == [lb["id"]]
    assert len(bundle_definition(graph, [lb["id"]], include_related=True)["resourceIds"]) == 2
    plan = review(console, [lb["id"]], RUN2)
    console.arm.resources[pip["id"].lower()]["tags"]["owner"] = "changed"
    with pytest.raises(BackupError, match="Shared dependency changed"):
        execute(console, plan)
    assert not any(call[0] == "PUT" for call in console.arm.calls)


def test_address_dependencies_require_explicit_acknowledgement(console):
    lb, pool = lb_resources()
    capture(console, [lb, pool])
    with pytest.raises(BackupError, match="acknowledge"):
        review(console, [lb["id"]], RUN2, acknowledgeExternal=False)


def test_partial_failure_keeps_applied_ids_and_safety_without_rollback(console):
    lb, pool = lb_resources()
    capture(console, [lb, pool])
    plan = review(console, [lb["id"]], RUN2)
    original = console.arm.request

    def fail_child(method, path, api_version=None, body=None):
        if method == "PUT" and path == pool["id"]:
            raise BackupError("Child write unavailable")
        return original(method, path, api_version, body)

    job = {"id": "partial", "writeAttempted": False}
    with patch.object(console.arm, "request", side_effect=fail_child):
        with pytest.raises(BackupError, match="Child write unavailable"):
            execute(console, plan, job)
    assert job["writeAttempted"] and job["appliedResources"] == [lb["id"]]
    assert console.read_run(job["safetyRunId"])["verified"]


def test_cycles_and_expansion_limit_are_explicit():
    graph = {"edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}]}
    with pytest.raises(BackupError, match="cycle"):
        restore_order(graph, ["a", "b"])
    with pytest.raises(BackupError, match="1..50"):
        bundle_definition({"nodes": [], "edges": [], "addresses": []}, [], include_related=True)


def test_front_door_parent_selection_captures_contained_endpoints_and_policy_matches():
    parent = resource(AFD, "frontdoor", {})
    parent["sku"] = {"name": "Standard_AzureFrontDoor"}
    parent["location"] = "global"
    endpoint = {"id": parent["id"] + "/afdEndpoints/public", "name": "public",
                "type": AFD_ENDPOINT, "location": "global", "properties": {"enabledState": "Enabled"}}
    graph = topology([envelope(parent), envelope(endpoint)])
    assert bundle_definition(graph, [parent["id"]], include_related=False)["resourceIds"] == [parent["id"], endpoint["id"]]
    assert LiveConsole.selected({**endpoint, "tags": TAGS}, {"scopeIds": [parent["id"]], "types": [AFD], "tags": []})


def test_tag_capable_endpoint_empty_tags_keep_verified_parent_ownership_not_fabricated_raw_tags():
    parent = resource(AFD, "frontdoor", {})
    parent["sku"] = {"name": "Standard_AzureFrontDoor"}
    endpoint = {"id": parent["id"] + "/afdEndpoints/public", "name": "public",
                "location": "global", "tags": {}, "properties": {"enabledState": "Enabled"}}
    stored = envelope(endpoint)
    stored["metadata"] = {"ownershipParent": parent["id"], "tags": TAGS}
    graph = topology([envelope(parent), stored])
    assert graph["nodes"][1]["tags"] == TAGS
    assert endpoint["tags"] == {}
    stored["metadata"]["tags"] = {**TAGS, "customer": "edge"}
    assert descriptor(stored)["customers"] == ["edge"]
    assert endpoint["tags"] == {}
    stored["metadata"]["ownershipParent"] = parent["id"] + "-outside"
    assert topology([stored])["nodes"][0]["tags"] == {}


def test_front_door_route_waits_for_enabled_origin_and_rule_children(console):
    profile = resource(AFD, "frontdoor", {})
    profile["sku"] = {"name": "Standard_AzureFrontDoor"}
    profile["location"] = "global"
    root = profile["id"]

    def child(kind, suffix, properties, **extra):
        return {"id": root + suffix, "name": suffix.rsplit("/", 1)[1], "type": kind,
                "properties": properties, **extra}

    endpoint = child(AFD_ENDPOINT, "/afdEndpoints/public", {"enabledState": "Enabled"},
                     location="global", tags={})
    group = child(AFD_ORIGIN_GROUP, "/originGroups/backend", {"loadBalancingSettings": {
        "sampleSize": 4, "successfulSamplesRequired": 3, "additionalLatencyInMilliseconds": 50}})
    origin = child(AFD_ORIGIN, "/originGroups/backend/origins/http",
                   {"hostName": "example.test", "httpPort": 80, "httpsPort": 443, "enabledState": "Enabled"})
    ruleset = child(AFD_RULESET, "/ruleSets/headers", {})
    rule = child(AFD_RULE, "/ruleSets/headers/rules/header", {"order": 1, "conditions": [],
        "actions": [{"name": "ModifyResponseHeader", "parameters": {
            "typeName": "DeliveryRuleHeaderActionParameters", "headerAction": "Overwrite",
            "headerName": "X-Lab", "value": "recovered"}}]})
    route = child(AFD_ROUTE, "/afdEndpoints/public/routes/http", {"originGroup": {"id": group["id"]},
        "ruleSets": [{"id": ruleset["id"]}], "patternsToMatch": ["/*"], "supportedProtocols": ["Http", "Https"]})
    raws = [profile, endpoint, group, origin, ruleset, rule, route]
    capture(console, raws)
    graph = topology(console.read_run(RUN2)["envelopes"])
    order = bundle_definition(graph, [root], include_related=False)["resourceIds"]
    assert order.index(origin["id"]) < order.index(route["id"])
    assert order.index(rule["id"]) < order.index(route["id"])
    for raw in raws:
        del console.arm.resources[raw["id"].lower()]
    plan = review(console, [root], RUN2, "create")
    result = execute(console, plan)
    assert len(result["resourceIds"]) == 7


@pytest.mark.parametrize("field", ["enableDestinationServiceEndpoint", "allowBackendPortConflict",
                                  "disableConnectionTracking", "enableConnectionTracking"])
def test_unreviewed_enabled_lb_flags_fail_closed_and_false_values_are_excluded(field):
    lb, _ = lb_resources()
    rule = lb["properties"]["loadBalancingRules"][0]["properties"]
    rule[field] = False
    assert field not in restore_body(lb, LB)["properties"]["loadBalancingRules"][0]["properties"]
    rule[field] = True
    with pytest.raises(BackupError, match="not replayable"):
        restore_body(lb, LB)


def test_required_types_unknown_fields_and_certificate_boundaries():
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static", "idleTimeoutInMinutes": 4.5})
    with pytest.raises(BackupError, match="expected integer"):
        restore_body(pip, PIP)
    pip["properties"] = {"newUnreviewedSetting": True}
    with pytest.raises(BackupError, match="not in the reviewed API"):
        restore_body(pip, PIP)
    agw = resource(AGW, "gateway", {"sslCertificates": [{"name": "tls"}]})
    with pytest.raises(BackupError, match="[Cc]ertificate"):
        restore_body(agw, AGW)
    waf = resource(WAF, "policy", {"customRules": [{"skippedManagedRuleSets": [{"ruleSetType": "OWASP"}]}]})
    with pytest.raises(BackupError, match="bypass"):
        restore_body(waf, WAF)


def test_projection_does_not_mutate_original_and_internal_collection_ids_normalize():
    lb, _ = lb_resources()
    before = encode_json(lb)
    projected = restore_body(lb, LB)
    normalized = configuration_body(lb, LB)
    projected["tags"]["owner"] = "different"
    assert encode_json(lb) == before
    assert "id" not in normalized["properties"]["backendAddressPools"][0]
    assert normalized["properties"]["loadBalancingRules"][0]["properties"]["backendAddressPool"]["id"]
    assert digest(encode_json(normalized))


def test_current_graph_does_not_send_restore_bodies_to_the_browser(console):
    graph = BundleConsole(console).inventory_graph()
    assert graph["nodes"] and all("body" not in node for node in graph["nodes"])


def test_child_missing_parent_is_missing_but_denied_parent_is_not_absence(console):
    resource_id = SCOPE + "/providers/Microsoft.Cdn/profiles/deleted/afdEndpoints/deleted"
    child = console.config.resource(resource_id)
    with patch.object(console.arm, "request", side_effect=[
        ArmHttpError(404, "ParentResourceNotFound"), {"tags": {"armbackupLab": "unit-lab"}},
    ]):
        assert console.observe(child, PROFILE_APIS[AFD])["status"] == "missing"
    with patch.object(console.arm, "request", side_effect=ArmHttpError(403, "AuthorizationFailed")):
        assert console.observe(child, PROFILE_APIS[AFD])["status"] == "error"


def test_inventory_collection_404_during_parent_deletion_is_confirmed_not_a_blank_success(console):
    parent = resource(AFD, "frontdoor", {})
    parent["sku"] = {"name": "Standard_AzureFrontDoor"}
    original_pages = console.arm.pages
    original_request = console.arm.request

    def pages(path, api):
        if path == SCOPE + "/resources":
            yield copy.deepcopy(parent)
        elif path == parent["id"] + "/afdEndpoints":
            raise ArmHttpError(404, "NotFound")
        else:
            yield from original_pages(path, api)

    def request(method, path, api=None, body=None):
        if method == "GET" and path == parent["id"]:
            raise ArmHttpError(404, "ResourceNotFound")
        return original_request(method, path, api, body)

    with patch.object(console.arm, "pages", side_effect=pages), patch.object(console.arm, "request", side_effect=request):
        assert console.inventory() == []
    with patch.object(console.arm, "pages", side_effect=pages):
        console.arm.resources[parent["id"].lower()] = parent
        with pytest.raises(ArmHttpError):
            console.inventory()


def test_gateway_log_query_is_fixed_bounded_and_keeps_partial_errors_explicit(console):
    reader = LogsReader(Mock(), SID, SCOPE)
    rid = SCOPE + "/providers/Microsoft.Network/applicationGateways/gateway"
    names = ["TimeGenerated", "Category", "Status", "Detail", "RuleId", "TransactionId"]
    response = Mock(status_code=200)
    response.json.return_value = {"tables": [{"columns": [{"name": name} for name in names], "rows": []}]}
    with patch("armbackup.monitoring.requests.post", return_value=response) as request:
        result = reader.gateway(rid)
        statement = request.call_args.kwargs["json"]["query"]
        assert result["source"] == "log-analytics" and result["logs"] == []
        assert "ago(24h)" in statement and "take 200" in statement and "AGWFirewallLogs" in statement
        assert "DetailedData" not in statement and "ClientIp" not in statement
        response.json.return_value["error"] = {"code": "PartialError"}
        with pytest.raises(BackupError, match="partial error"):
            reader.gateway(rid)
    with pytest.raises(BackupError, match="inside"):
        reader.gateway(rid.replace(GROUP, "outside"))


def test_gateway_backend_health_error_cannot_be_a_green_recovery_default(console):
    from armbackup.http import ArmClient

    rid = SCOPE + "/providers/Microsoft.Network/applicationGateways/gateway"
    arm = Mock(spec=ArmClient)
    console.arm = arm
    arm.request.side_effect = [
        {"tags": {"armbackupLab": "unit-lab"}},
        {"id": rid, "tags": TAGS, "properties": {"provisioningState": "Succeeded"}},
    ]
    arm.request_operation.return_value = {"status": "Succeeded"}
    with pytest.raises(BackupError, match="expected result"):
        console.troubleshoot(rid)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows extended path namespace")
def test_concurrent_directory_creation_does_not_turn_an_inside_path_into_an_escape(tmp_path):
    archive = LocalArchive(tmp_path / "archive")
    archive.put("runs/source/discovery.json", b"{}")
    real_resolve = Path.resolve

    def extended(path, *args, **kwargs):
        value = real_resolve(path, *args, **kwargs)
        return Path("\\\\?\\" + str(value)) if path.name == "snapshot.json" else value

    with patch.object(Path, "resolve", extended):
        archive.put("runs/source/resources/snapshot.json", b"{}")
        assert archive.get("runs/source/resources/snapshot.json") == b"{}"
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda index: archive.put(f"runs/source/resources/{index}.json", b"{}"), range(64)))
    assert len(archive.names("runs/source/resources")) == 65
    with pytest.raises(BackupError, match="Unsafe"):
        archive.put("../outside", b"{}")
