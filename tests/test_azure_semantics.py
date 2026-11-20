# ruff: noqa: F811
import copy

import pytest
from test_console import SCOPE
from test_resource_bundles import (  # noqa: F401
    AGW,
    LB,
    PIP,
    RUN2,
    TAGS,
    capture,
    console,
    envelope,
    execute,
    lb_resources,
    resource,
    review,
)

from armbackup.azure_semantics import (
    apply_override,
    immutable_conflicts,
    keep_current,
    parse_path,
)
from armbackup.contracts import BackupError
from armbackup.resource_bundles import bundle_definition, clone_targets, topology
from armbackup.resource_profiles import LB_POOL, VNET, restore_body

SUBNET = SCOPE + "/providers/Microsoft.Network/virtualNetworks/hub/subnets/app"


def vnet_pair():
    spoke = resource(VNET, "spoke", {"addressSpace": {"addressPrefixes": ["10.1.0.0/16"]}, "subnets": []})
    hub = resource(VNET, "hub", {
        "addressSpace": {"addressPrefixes": ["10.0.0.0/16"]},
        "subnets": [{"name": "app", "properties": {
            "addressPrefix": "10.0.1.0/24",
            "ipConfigurations": [{"id": SCOPE + "/providers/Microsoft.Network/networkInterfaces/nic/ipConfigurations/one"}],
            "privateEndpoints": [{"id": SCOPE + "/providers/Microsoft.Network/privateEndpoints/pe"}],
        }}],
        "virtualNetworkPeerings": [{"name": "to-spoke", "properties": {
            "remoteVirtualNetwork": {"id": spoke["id"]}, "allowVirtualNetworkAccess": True,
            "peeringState": "Connected"}}],
    })
    return hub, spoke


def test_vnet_peerings_and_attachments_are_never_replayed_nor_followed():
    hub, spoke = vnet_pair()
    body = restore_body(hub, VNET)
    assert "virtualNetworkPeerings" not in body["properties"]
    assert "ipConfigurations" not in body["properties"]["subnets"][0]["properties"]
    graph = topology([envelope(hub), envelope(spoke)])
    node = next(item for item in graph["nodes"] if item["name"] == "hub")
    assert [item["kind"] for item in node["excluded"]] == ["peering", "attachment"]
    assert node["excluded"][0]["target"] == spoke["id"]
    assert not [edge for edge in graph["edges"] if edge["to"].lower() == spoke["id"].lower()]
    definition = bundle_definition(graph, [hub["id"]], include_related=True)
    assert definition["resourceIds"] == [hub["id"]]
    assert {item["kind"] for item in definition["excludedRelations"]} == {"peering", "attachment"}


def test_optional_related_resources_can_be_left_out_but_children_stay_with_parents():
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static"})
    lb, pool = lb_resources()
    lb["properties"]["frontendIPConfigurations"] = [
        {"name": "public", "properties": {"publicIPAddress": {"id": pip["id"]}}}]
    graph = topology([envelope(lb), envelope(pool), envelope(pip)])
    both = bundle_definition(graph, [lb["id"]], include_related=True)
    assert pip["id"] in both["resourceIds"]
    edge = next(item for item in graph["edges"] if item["to"].lower() == pip["id"].lower())
    assert edge["relation"] == "required"
    alone = bundle_definition(graph, [lb["id"]], include_related=True, exclude_related=[pip["id"]])
    assert pip["id"] not in alone["resourceIds"] and pool["id"] in alone["resourceIds"]
    assert [item["to"] for item in alone["externalReferences"]] == [pip["id"]]


def test_immutable_fields_are_listed_and_kept_current_on_request():
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static", "publicIPAddressVersion": "IPv4"})
    pip["zones"] = ["1"]
    backup = restore_body(pip, PIP)
    live = copy.deepcopy(backup)
    live["location"], live["zones"] = "koreasouth", ["2"]
    conflicts = immutable_conflicts(PIP, backup, live)
    assert {item["path"] for item in conflicts} == {"location", "zones"}
    assert all(item["keepable"] for item in conflicts)
    report = keep_current(backup, live, conflicts)
    assert backup["location"] == "koreasouth" and backup["zones"] == ["2"]
    assert {item["change"] for item in report} == {"kept-current"}
    assert immutable_conflicts(PIP, backup, live) == []
    live["location"] = "Korea South"
    assert immutable_conflicts(PIP, backup, live) == []


def test_gateway_family_cannot_change_and_is_not_keepable():
    v1 = {"location": "koreacentral", "sku": {"name": "Standard_Medium"}}
    v2 = {"location": "koreacentral", "sku": {"name": "Standard_v2"}}
    assert immutable_conflicts(AGW, v2, {**v2, "sku": {"name": "WAF_v2"}}) == []
    conflicts = immutable_conflicts(AGW, v1, v2)
    assert [item["keepable"] for item in conflicts] == [False]
    with pytest.raises(BackupError, match="sku.name"):
        keep_current(copy.deepcopy(v1), v2, conflicts)


def test_update_keeps_immutable_difference_by_default_and_blocks_on_explicit_request(console):
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static", "publicIPAddressVersion": "IPv4"})
    capture(console, [pip])
    console.arm.resources[pip["id"].lower()]["location"] = "koreasouth"
    with pytest.raises(BackupError, match="location"):
        review(console, ids=[pip["id"]], run=RUN2, mode="update", immutableConflict="block")
    plan = review(console, ids=[pip["id"]], run=RUN2, mode="update")
    assert plan["actions"][0]["adjustments"][0]["change"] == "kept-current"
    result = execute(console, plan)
    assert result["omittedOrKept"][0]["path"] == "location"
    puts = [call for call in console.arm.calls if call[0] == "PUT"]
    assert puts[-1][3]["location"] == "koreasouth"
    with pytest.raises(BackupError, match="only applies to update"):
        review(console, ids=[pip["id"]], run=RUN2, mode="clone", clonePrefix="twin", immutableConflict="keep-current")


def test_vnet_update_preserves_post_backup_subnet_by_default_and_never_silently_deletes(console):
    hub, _ = vnet_pair()
    capture(console, [hub])
    live = console.arm.resources[hub["id"].lower()]
    live["properties"]["subnets"].append({"name": "later", "properties": {"addressPrefix": "10.0.2.0/24"}})
    live["tags"]["drift"] = "yes"
    with pytest.raises(BackupError, match="later"):
        review(console, ids=[hub["id"]], run=RUN2, mode="update", immutableConflict="block")
    plan = review(console, ids=[hub["id"]], run=RUN2, mode="update")
    assert any(adj["path"] == "properties.subnets[name=later]" and adj["change"] == "kept-current"
               for adj in plan["actions"][0]["adjustments"])
    execute(console, plan)
    subnet_names = {s["name"] for s in console.arm.resources[hub["id"].lower()]["properties"]["subnets"]}
    assert subnet_names == {"app", "later"}
    assert "drift" not in console.arm.resources[hub["id"].lower()]["tags"]


def test_clone_changes_dns_label_names_and_fields_with_the_reasons_recorded(console):
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static", "idleTimeoutInMinutes": 4,
                                   "dnsSettings": {"domainNameLabel": "web", "reverseFqdn": "web.example.test."}})
    capture(console, [pip])
    plan = review(console, ids=[pip["id"]], run=RUN2, mode="clone", clonePrefix="dr", overrides=[
        {"resourceId": pip["id"], "path": "name", "value": "public-dr"},
        {"resourceId": pip["id"], "path": "properties.idleTimeoutInMinutes", "value": 10},
        {"resourceId": pip["id"], "path": "properties.dnsSettings.domainNameLabel", "value": "web-secondary"},
        {"resourceId": pip["id"], "path": "tags.tier", "value": "dr"},
    ])
    action = plan["actions"][0]
    assert action["resourceId"].endswith("/public-dr")
    changes = {item["path"]: item["change"] for item in action["adjustments"]}
    assert changes == {"properties.idleTimeoutInMinutes": "overridden",
                       "properties.dnsSettings.domainNameLabel": "overridden",
                       "tags.tier": "overridden",
                       "properties.dnsSettings.reverseFqdn": "dropped"}
    result = execute(console, plan)
    body = console.arm.resources[result["resourceIds"][0].lower()]
    assert body["properties"]["idleTimeoutInMinutes"] == 10 and body["tags"]["tier"] == "dr"
    assert body["properties"]["dnsSettings"] == {"domainNameLabel": "web-secondary"}


@pytest.mark.parametrize("override,message", [
    ({"path": "properties.dnsSettings.domainNameLabel", "value": "Bad_Label"}, "형식"),
    ({"path": "properties.ipAddress", "value": "1.2.3.4"}, "배정하거나 계산"),
    ({"path": "id", "value": "x"}, "서버가 관리"),
    ({"path": "properties.dnsSettings.name", "value": "x"}, "이름 변경"),
    ({"path": "properties.publicIPPrefix.id", "value": "/subscriptions/x"}, "서버가 관리"),
    ({"path": "properties.publicIPPrefix", "value": {"id": "/subscriptions/x/y"}}, "ARM 참조"),
    ({"path": "tags[0]", "value": "x"}, "필드 이름"),
    ({"path": "name", "value": "bad name"}, "새 이름"),
    ({"path": "location", "value": 7}, "expected string"),
])
def test_unsafe_or_invalid_overrides_are_refused_before_any_write(console, override, message):
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static"})
    capture(console, [pip])
    with pytest.raises(BackupError, match=message):
        review(console, ids=[pip["id"]], run=RUN2, mode="clone", clonePrefix="dr",
               overrides=[{"resourceId": pip["id"], **override}])
    assert not [call for call in console.arm.calls if call[0] == "PUT"]


def test_overrides_allow_property_changes_across_modes_while_name_stays_clone_only(console):
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static"})
    capture(console, [pip])
    with pytest.raises(BackupError, match="only allowed for clone"):
        review(console, ids=[pip["id"]], run=RUN2, mode="update",
               overrides=[{"resourceId": pip["id"], "path": "name", "value": "renamed-public"}])
    upd_plan = review(console, ids=[pip["id"]], run=RUN2, mode="update",
                      overrides=[{"resourceId": pip["id"], "path": "tags.a", "value": "b"}])
    assert any(adj["path"] == "tags.a" and adj["change"] == "overridden" for adj in upd_plan["actions"][0]["adjustments"])
    execute(console, upd_plan)
    assert console.arm.resources[pip["id"].lower()]["tags"]["a"] == "b"
    with pytest.raises(BackupError, match="not part of this (clone|operation)"):
        review(console, ids=[pip["id"]], run=RUN2, mode="clone", clonePrefix="dr",
               overrides=[{"resourceId": SCOPE + "/providers/Microsoft.Network/publicIPAddresses/other",
                           "path": "tags.a", "value": "b"}])


def test_override_paths_select_list_items_by_name():
    body = {"properties": {"subnets": [{"name": "App", "properties": {"addressPrefix": "10.0.1.0/24"}}]}}
    apply_override(body, "properties.subnets[name=app].properties.addressPrefix", "10.0.9.0/24")
    assert body["properties"]["subnets"][0]["properties"]["addressPrefix"] == "10.0.9.0/24"
    assert parse_path("a.b[0].c[name=x]") == [("key", "a"), ("key", "b"), ("index", 0), ("key", "c"), ("name", "x")]
    with pytest.raises(BackupError, match="한 개|하나"):
        apply_override(body, "properties.subnets[name=missing].properties.addressPrefix", "10.0.9.0/24")
    with pytest.raises(BackupError, match="형식"):
        apply_override(body, "properties.subnets[name=app].properties.addressPrefix", "10.0.9.5/24")


def test_vnet_clone_keeps_subnets_inside_its_address_space_and_warns_about_the_original():
    hub, _ = vnet_pair()
    graph = topology([envelope(hub)])
    key = hub["id"].lower()
    plain = clone_targets(graph, [hub["id"]], "dr")[key]
    assert "virtualNetworkPeerings" not in plain["body"]["properties"]
    assert "피어링" in plain["warnings"][0]
    moved = clone_targets(graph, [hub["id"]], "dr", overrides={key: [
        {"path": "properties.addressSpace.addressPrefixes", "value": ["10.20.0.0/16"]},
        {"path": "properties.subnets[name=app].properties.addressPrefix", "value": "10.20.1.0/24"}]})[key]
    assert moved["warnings"] == []
    with pytest.raises(BackupError, match="주소 공간 밖"):
        clone_targets(graph, [hub["id"]], "dr", overrides={key: [
            {"path": "properties.addressSpace.addressPrefixes", "value": ["10.20.0.0/16"]}]})


def internal_lb(method="Static", subnet=SUBNET):
    lb, pool = lb_resources()
    lb["properties"]["frontendIPConfigurations"] = [{"name": "internal", "properties": {
        "privateIPAllocationMethod": method, "privateIPAddress": "10.0.1.10", "subnet": {"id": subnet}}}]
    return lb, pool


def test_static_private_ip_in_a_shared_subnet_becomes_dynamic_in_the_clone_unless_replaced():
    lb, pool = internal_lb()
    graph = topology([envelope(lb), envelope(pool)])
    key = lb["id"].lower()
    mapped = clone_targets(graph, [lb["id"], pool["id"]], "dr")[key]
    frontend = mapped["body"]["properties"]["frontendIPConfigurations"][0]["properties"]
    assert frontend["privateIPAllocationMethod"] == "Dynamic" and "privateIPAddress" not in frontend
    assert [item["change"] for item in mapped["adjustments"] if "frontend" in item["path"]] == ["dynamic"]
    path = "properties.frontendIPConfigurations[name=internal].properties.privateIPAddress"
    replaced = clone_targets(graph, [lb["id"], pool["id"]], "dr",
                             overrides={key: [{"path": path, "value": "10.0.1.11"}]})[key]
    kept = replaced["body"]["properties"]["frontendIPConfigurations"][0]["properties"]
    assert kept["privateIPAllocationMethod"] == "Static" and kept["privateIPAddress"] == "10.0.1.11"


def test_assigned_dynamic_private_ip_is_not_copied():
    lb, pool = internal_lb("Dynamic")
    graph = topology([envelope(lb), envelope(pool)])
    mapped = clone_targets(graph, [lb["id"], pool["id"]], "dr")[lb["id"].lower()]
    assert "privateIPAddress" not in mapped["body"]["properties"]["frontendIPConfigurations"][0]["properties"]


def test_cloned_subnet_keeps_its_static_ip_because_the_range_is_copied_too():
    hub, _ = vnet_pair()
    lb, pool = internal_lb()
    graph = topology([envelope(hub), envelope(lb), envelope(pool)])
    mapped = clone_targets(graph, [hub["id"], lb["id"], pool["id"]], "dr")[lb["id"].lower()]
    frontend = mapped["body"]["properties"]["frontendIPConfigurations"][0]["properties"]
    assert frontend["privateIPAddress"] == "10.0.1.10" and "/dr-hub/" in frontend["subnet"]["id"]
    assert [item for item in mapped["adjustments"] if "frontend" in item["path"]] == []


def test_clone_across_locations_needs_the_referenced_resources_to_move_too(console):
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static"})
    pip["sku"] = {"name": "Standard"}
    lb, pool = lb_resources()
    lb["sku"] = {"name": "Standard"}
    lb["properties"]["frontendIPConfigurations"] = [{"name": "public", "properties": {"publicIPAddress": {"id": pip["id"]}}}]
    capture(console, [pip, lb, pool])
    move = [{"resourceId": lb["id"], "path": "location", "value": "koreasouth"}]
    with pytest.raises(BackupError, match="위치"):
        review(console, ids=[lb["id"]], run=RUN2, mode="clone", clonePrefix="dr", includeRelated=True, overrides=move)
    both = move + [{"resourceId": pip["id"], "path": "location", "value": "koreasouth"}]
    plan = review(console, ids=[lb["id"]], run=RUN2, mode="clone", clonePrefix="dr", includeRelated=True, overrides=both)
    assert {item["resourceType"] for item in plan["actions"]} == {PIP, LB, LB + "/backendaddresspools"}


NIC = SCOPE + "/providers/Microsoft.Network/networkInterfaces/nic/ipConfigurations/one"


def balancer_with_members():
    lb, pool = lb_resources()
    pool["properties"]["backendIPConfigurations"] = [{"id": NIC}]
    pool["properties"]["loadBalancerBackendAddresses"].append(
        {"name": "nic-member", "properties": {"networkInterfaceIPConfiguration": {"id": NIC}}})
    lb["properties"]["backendAddressPools"] = [copy.deepcopy(pool)]
    return lb, pool


def test_cloned_backend_pool_is_new_and_empty_while_the_nic_members_stay_with_the_original():
    lb, pool = balancer_with_members()
    graph = topology([envelope(lb), envelope(pool)])
    node = next(item for item in graph["nodes"] if item["resourceType"] == LB + "/backendaddresspools")
    assert [(item["kind"], item["count"]) for item in node["excluded"]] == [("members", 1)]
    mapped = clone_targets(graph, [lb["id"], pool["id"]], "dr")
    child = mapped[pool["id"].lower()]
    assert child["resourceId"].endswith("/dr-load-balancer/backendAddressPools/http")
    assert "loadBalancerBackendAddresses" not in child["body"]["properties"]
    assert [item["change"] for item in child["adjustments"]] == ["dropped"]
    assert "NIC 1개" in child["warnings"][0]
    root = mapped[lb["id"].lower()]
    inline = root["body"]["properties"]["backendAddressPools"][0]["properties"]
    assert "loadBalancerBackendAddresses" not in inline
    assert root["adjustments"][0]["path"] == "properties.backendAddressPools[name=http].properties.loadBalancerBackendAddresses"
    rule = root["body"]["properties"]["loadBalancingRules"][0]["properties"]
    assert rule["backendAddressPool"]["id"] == child["resourceId"]


def test_restoring_the_same_balancer_keeps_ip_members_but_never_writes_nic_owned_ones():
    _, pool = balancer_with_members()
    members = restore_body(pool, LB + "/backendaddresspools")["properties"]["loadBalancerBackendAddresses"]
    assert [item["name"] for item in members] == ["server"]


def test_a_backend_pool_cannot_be_cloned_without_its_balancer():
    lb, pool = lb_resources()
    graph = topology([envelope(lb), envelope(pool)])
    with pytest.raises(BackupError, match="부모 안에서만"):
        clone_targets(graph, [pool["id"]], "dr")


def test_balancer_with_nic_backed_pool_is_in_the_restore_profile():
    from armbackup.support import verify_restore_profile

    lb, _ = balancer_with_members()
    lb["sku"] = {"name": "Standard"}
    lb["properties"]["frontendIPConfigurations"] = [{"name": "public", "properties": {"publicIPAddress": {"id": SCOPE + "/p"}}}]
    lb["properties"]["loadBalancingRules"][0]["properties"]["protocol"] = "Tcp"
    verify_restore_profile(lb)


def test_real_arm_gateway_sku_zones_and_operational_state_rules(console):
    from armbackup.azure_semantics import inspect_runtime_state

    v1_arm = {"location": "koreacentral", "properties": {"sku": {"name": "Standard_Medium"}}}
    v2_arm = {"location": "koreacentral", "zones": ["2", "1"], "properties": {"sku": {"name": "WAF_v2"}}}
    fam_conflicts = immutable_conflicts(AGW, v1_arm, v2_arm)
    assert any(item["path"] == "properties.sku.name" and item["keepable"] is False for item in fam_conflicts)
    assert immutable_conflicts(AGW, v2_arm, {**copy.deepcopy(v2_arm), "zones": ["1", "2"]}) == []
    zone_conflicts = immutable_conflicts(AGW, {**copy.deepcopy(v2_arm), "zones": ["1"]}, v2_arm)
    assert [item["path"] for item in zone_conflicts] == ["zones"] and zone_conflicts[0]["keepable"] is True

    gw_sub_a = SCOPE + "/providers/Microsoft.Network/virtualNetworks/shared/subnets/gw-a"
    gw_sub_b = SCOPE + "/providers/Microsoft.Network/virtualNetworks/shared/subnets/gw-b"
    other_vnet_sub = SCOPE + "/providers/Microsoft.Network/virtualNetworks/other/subnets/gw-a"
    snap_gw = {"location": "koreacentral", "properties": {
        "sku": {"name": "WAF_v2"}, "gatewayIPConfigurations": [{"name": "gwip", "properties": {"subnet": {"id": gw_sub_a}}}],
    }}
    live_running = {"location": "koreacentral", "properties": {
        "sku": {"name": "WAF_v2"}, "operationalState": "Running",
        "gatewayIPConfigurations": [{"name": "gwip", "properties": {"subnet": {"id": gw_sub_b}}}],
    }}
    running_conflicts = immutable_conflicts(AGW, snap_gw, live_running, live_running)
    assert len(running_conflicts) == 1 and not running_conflicts[0]["keepable"] and "Running" in running_conflicts[0]["reason"]
    live_stopped = {**copy.deepcopy(live_running), "properties": {**copy.deepcopy(live_running["properties"]), "operationalState": "Stopped"}}
    assert immutable_conflicts(AGW, snap_gw, live_stopped, live_stopped) == []
    diff_vnet = {**copy.deepcopy(live_stopped), "properties": {
        **copy.deepcopy(live_stopped["properties"]),
        "gatewayIPConfigurations": [{"name": "gwip", "properties": {"subnet": {"id": other_vnet_sub}}}],
    }}
    assert immutable_conflicts(AGW, snap_gw, diff_vnet, diff_vnet)[0]["keepable"] is False

    block, _ = inspect_runtime_state(AGW, {"properties": {"provisioningState": "Succeeded", "operationalState": "Stopping"}}, "update")
    assert block and "Stopping" in block
    block_none, stopped_warn = inspect_runtime_state(AGW, {"properties": {"provisioningState": "Succeeded", "operationalState": "Stopped"}}, "update")
    assert block_none is None and any("Stopped" in w and "자동" in w for w in stopped_warn)
    block_failed, failed_warn = inspect_runtime_state(AGW, {"properties": {"provisioningState": "Failed", "operationalState": "Running"}}, "update")
    assert block_failed is None and any("Failed" in w for w in failed_warn)


def test_public_ip_attached_state_and_policy_iptags_immutability(console):
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Dynamic", "publicIPAddressVersion": "IPv4"})
    pip["sku"] = {"name": "Basic", "tier": "Regional"}
    capture(console, [pip])
    live = console.arm.resources[pip["id"].lower()]
    live["properties"]["publicIPAllocationMethod"] = "Static"
    live["properties"]["ipConfiguration"] = {"id": SCOPE + "/providers/Microsoft.Network/loadBalancers/lb/frontendIPConfigurations/fe"}
    live["properties"]["ipTags"] = [{"ipTagType": "FirstPartyUsage", "tag": "/Unprivileged"}]
    with pytest.raises(BackupError, match="publicIPAllocationMethod"):
        review(console, ids=[pip["id"]], run=RUN2, mode="update", immutableConflict="block")
    plan = review(console, ids=[pip["id"]], run=RUN2, mode="update")
    kept_paths = {item["path"] for item in plan["actions"][0]["adjustments"] if item["change"] == "kept-current"}
    assert {"properties.publicIPAllocationMethod", "properties.ipTags"} <= kept_paths


def test_load_balancer_update_preserves_pool_with_attached_nics_by_default_and_blocks_on_request(console):
    lb, pool = lb_resources()
    capture(console, [lb, pool])
    live_lb = console.arm.resources[lb["id"].lower()]
    live_lb["properties"]["backendAddressPools"].append({
        "name": "active-vm-pool",
        "properties": {"backendIPConfigurations": [{"id": NIC}]},
    })
    with pytest.raises(BackupError, match="active-vm-pool"):
        review(console, ids=[lb["id"]], run=RUN2, mode="update", immutableConflict="block")
    plan = review(console, ids=[lb["id"]], run=RUN2, mode="update")
    lb_action = next(item for item in plan["actions"] if item["resourceType"] == LB)
    assert any(adj["path"] == "properties.backendAddressPools[name=active-vm-pool]" and adj["change"] == "kept-current"
               for adj in lb_action["adjustments"])
    execute(console, plan)
    pool_names = {p["name"] for p in console.arm.resources[lb["id"].lower()]["properties"]["backendAddressPools"]}
    assert {"http", "active-vm-pool"} <= pool_names


def test_gateway_pfx_certificates_keep_live_cert_on_update_and_drop_only_pfx_listeners_on_clone(console):
    agw_id = SCOPE + "/providers/Microsoft.Network/applicationGateways/agw-mixed"
    agw = {
        "id": agw_id, "name": "agw-mixed", "type": AGW, "location": "koreacentral",
        "tags": copy.deepcopy(TAGS),
        "identity": {"type": "SystemAssigned"},
        "properties": {
            "sku": {"name": "Standard_v2", "tier": "Standard_v2"},
            "gatewayIPConfigurations": [{"name": "gwip", "properties": {"subnet": {"id": SUBNET}}}],
            "frontendIPConfigurations": [{"name": "priv", "properties": {
                "privateIPAllocationMethod": "Static", "privateIPAddress": "10.0.1.10", "subnet": {"id": SUBNET},
            }}],
            "frontendPorts": [
                {"name": "p80", "properties": {"port": 80}},
                {"name": "p443", "properties": {"port": 443}},
            ],
            "sslCertificates": [{"id": f"{agw_id}/sslCertificates/pfx-cert", "name": "pfx-cert",
                                 "properties": {"publicCertData": "MIIB"}}],
            "backendAddressPools": [{"name": "pool", "properties": {"backendAddresses": [{"ipAddress": "10.1.0.5"}]}}],
            "backendHttpSettingsCollection": [{"name": "bhs", "properties": {"port": 80, "protocol": "Http"}}],
            "httpListeners": [
                {"name": "http-lis", "properties": {
                    "protocol": "Http",
                    "frontendIPConfiguration": {"id": f"{agw_id}/frontendIPConfigurations/priv"},
                    "frontendPort": {"id": f"{agw_id}/frontendPorts/p80"},
                }},
                {"name": "https-lis", "properties": {
                    "protocol": "Https",
                    "frontendIPConfiguration": {"id": f"{agw_id}/frontendIPConfigurations/priv"},
                    "frontendPort": {"id": f"{agw_id}/frontendPorts/p443"},
                    "sslCertificate": {"id": f"{agw_id}/sslCertificates/pfx-cert"},
                }},
            ],
            "requestRoutingRules": [
                {"name": "http-rule", "properties": {
                    "ruleType": "Basic", "priority": 100,
                    "httpListener": {"id": f"{agw_id}/httpListeners/http-lis"},
                    "backendAddressPool": {"id": f"{agw_id}/backendAddressPools/pool"},
                    "backendHttpSettings": {"id": f"{agw_id}/backendHttpSettingsCollection/bhs"},
                }},
                {"name": "https-rule", "properties": {
                    "ruleType": "Basic", "priority": 110,
                    "httpListener": {"id": f"{agw_id}/httpListeners/https-lis"},
                    "backendAddressPool": {"id": f"{agw_id}/backendAddressPools/pool"},
                    "backendHttpSettings": {"id": f"{agw_id}/backendHttpSettingsCollection/bhs"},
                }},
            ],
        },
    }
    console.arm.resources[SUBNET.lower()] = {
        "id": SUBNET, "name": "app", "type": VNET + "/subnets",
        "location": "koreacentral",
        "properties": {"provisioningState": "Succeeded", "addressPrefix": "10.0.1.0/24"},
    }
    capture(console, [agw])
    console.arm.resources[agw_id.lower()]["tags"]["drift"] = "true"

    # 1. Update keeps live PFX cert and restores both HTTP and HTTPS listeners/rules!
    upd_plan = review(console, ids=[agw_id], run=RUN2, mode="update")
    upd_adj = {item["path"]: item["change"] for item in upd_plan["actions"][0]["adjustments"]}
    assert upd_adj["properties.sslCertificates[name=pfx-cert]"] == "kept-current"
    upd_res = execute(console, upd_plan)
    assert upd_res["omittedOrKept"]
    restored = console.arm.resources[agw_id.lower()]
    assert "drift" not in restored["tags"]
    assert {item["name"] for item in restored["properties"]["httpListeners"]} == {"http-lis", "https-lis"}

    # 2. Clone drops only uncreatable PFX cert + HTTPS listener/rule, cloning HTTP listener/rule/pool/settings!
    cln_plan = review(
        console, ids=[agw_id], run=RUN2, mode="clone", clonePrefix="dr",
        overrides=[{"resourceId": agw_id, "path": "properties.frontendIPConfigurations[name=priv].properties.privateIPAddress", "value": "10.0.1.20"}],
    )
    cln_dropped = {item["path"] for item in cln_plan["actions"][0]["adjustments"] if item["change"] == "dropped"}
    assert {
        "properties.sslCertificates[name=pfx-cert]",
        "properties.httpListeners[name=https-lis]",
        "properties.requestRoutingRules[name=https-rule]",
    } <= cln_dropped
    cln_res = execute(console, cln_plan)
    cloned_agw = console.arm.resources[cln_res["resourceIds"][0].lower()]
    assert [item["name"] for item in cloned_agw["properties"]["httpListeners"]] == ["http-lis"]
    assert [item["name"] for item in cloned_agw["properties"]["requestRoutingRules"]] == ["http-rule"]


def test_aks_load_balancer_clone_fills_placeholder_sample_ip_by_default_and_dedupes_summary(console):
    vnet_id = SCOPE + "/providers/Microsoft.Network/virtualNetworks/aks-vnet"
    snet_id = vnet_id + "/subnets/aks-subnet"
    pip_id = SCOPE + "/providers/Microsoft.Network/publicIPAddresses/aks-pip"
    lb_id = SCOPE + "/providers/Microsoft.Network/loadBalancers/capp-svc-lb"
    pool_id = lb_id + "/backendAddressPools/capp-svc-lbbepool"
    console.arm.resources[vnet_id.lower()] = {
        "id": vnet_id, "name": "aks-vnet", "type": VNET, "location": "koreacentral",
        "properties": {
            "provisioningState": "Succeeded",
            "addressSpace": {"addressPrefixes": ["10.224.0.0/16"]},
            "subnets": [{"id": snet_id, "name": "aks-subnet", "properties": {"addressPrefix": "10.224.0.0/24"}}],
        },
    }
    pip = resource(PIP, "aks-pip", {"publicIPAllocationMethod": "Static"})
    pip["sku"] = {"name": "Standard", "tier": "Regional"}
    addrs = [
        {"name": "node-1", "properties": {"ipAddress": "10.224.0.4", "virtualNetwork": {"id": vnet_id}}},
        {"name": "node-2", "properties": {"ipAddress": "10.224.0.5", "virtualNetwork": {"id": vnet_id}}},
    ]
    lb = {
        "id": lb_id, "name": "capp-svc-lb", "type": LB, "location": "koreacentral",
        "sku": {"name": "Standard", "tier": "Regional"},
        "tags": copy.deepcopy(TAGS),
        "properties": {
            "frontendIPConfigurations": [{"id": f"{lb_id}/frontendIPConfigurations/fe", "name": "fe",
                                          "properties": {"publicIPAddress": {"id": pip_id}}}],
            "backendAddressPools": [{"id": pool_id, "name": "capp-svc-lbbepool",
                                     "properties": {"loadBalancerBackendAddresses": copy.deepcopy(addrs)}}],
            "probes": [{"id": f"{lb_id}/probes/hp", "name": "hp",
                        "properties": {"protocol": "Tcp", "port": 80, "intervalInSeconds": 5}}],
            "loadBalancingRules": [{"name": "http", "properties": {
                "frontendIPConfiguration": {"id": f"{lb_id}/frontendIPConfigurations/fe"},
                "backendAddressPool": {"id": pool_id},
                "probe": {"id": f"{lb_id}/probes/hp"},
                "protocol": "Tcp", "frontendPort": 80, "backendPort": 80,
            }}],
        },
    }
    pool = {
        "id": pool_id, "name": "capp-svc-lbbepool", "type": LB_POOL,
        "properties": {"loadBalancerBackendAddresses": copy.deepcopy(addrs)},
    }
    capture(console, [pip, lb, pool])

    bundle_graph = console.bundle_graph(RUN2)
    lb_node = next(n for n in bundle_graph["nodes"] if n["id"].lower() == lb_id.lower())
    pool_hint = lb_node["cloneHints"]["backendPools"][0]
    assert pool_hint["name"] == "capp-svc-lbbepool"
    assert pool_hint["ipCount"] == 2
    assert pool_hint["suggestedPlaceholderIp"] == "10.224.0.250"

    # 1. Default clone mode ("placeholder") populates 10.224.0.250 into both LB and LB_POOL and deduplicates summary
    default_plan = review(console, ids=[lb_id], run=RUN2, includeRelated=True, mode="clone", clonePrefix="copy")
    pool_act = next(a for a in default_plan["actions"] if a["resourceType"] == LB_POOL)
    assert any(adj["change"] == "placeholder" and "10.224.0.250" in adj["reason"] for adj in pool_act["adjustments"])

    # Simulate Azure GET populating derived `subnet` on IP-based backend address during verification
    orig_request = console.arm.request

    def request_with_derived_subnet(method, path, api_version=None, body=None):
        res = orig_request(method, path, api_version, body)
        if method == "PUT":
            stored = console.arm.resources[path.lower()]
            if stored.get("type", "").lower() == LB_POOL:
                for entry in stored.get("properties", {}).get("loadBalancerBackendAddresses", []):
                    entry.setdefault("properties", {})["subnet"] = {"id": snet_id}
        return res

    console.arm.request = request_with_derived_subnet
    done = execute(console, default_plan)
    assert len(done["omittedOrKept"]) == 1
    assert done["omittedOrKept"][0]["change"] == "placeholder"
    cloned_pool_id = SCOPE + "/providers/Microsoft.Network/loadBalancers/copy-capp-svc-lb/backendAddressPools/capp-svc-lbbepool"
    cloned_addrs = console.arm.resources[cloned_pool_id.lower()]["properties"]["loadBalancerBackendAddresses"]
    assert len(cloned_addrs) == 1 and cloned_addrs[0]["properties"]["ipAddress"] == "10.224.0.250"

    # 2. Custom user placeholder IP is applied when inside VNet CIDR, and out-of-range IP is rejected
    custom_plan = review(
        console, ids=[lb_id], run=RUN2, includeRelated=True, mode="clone", clonePrefix="cust",
        placeholderIps={f"{lb_id.lower()}::capp-svc-lbbepool": "10.224.0.200"},
    )
    execute(console, custom_plan)
    cust_pool_id = SCOPE + "/providers/Microsoft.Network/loadBalancers/cust-capp-svc-lb/backendAddressPools/capp-svc-lbbepool"
    assert console.arm.resources[cust_pool_id.lower()]["properties"]["loadBalancerBackendAddresses"][0]["properties"]["ipAddress"] == "10.224.0.200"

    with pytest.raises(BackupError, match=r"10\.224\.0\.0/24"):
        review(
            console, ids=[lb_id], run=RUN2, includeRelated=True, mode="clone", clonePrefix="badip",
            placeholderIps={f"{lb_id.lower()}::capp-svc-lbbepool": "192.168.99.99"},
        )

    # 3. Empty and keep modes are also selectable before clone
    empty_plan = review(console, ids=[lb_id], run=RUN2, includeRelated=True, mode="clone", clonePrefix="emp", backendPoolMode="empty")
    execute(console, empty_plan)
    emp_pool_id = SCOPE + "/providers/Microsoft.Network/loadBalancers/emp-capp-svc-lb/backendAddressPools/capp-svc-lbbepool"
    assert "loadBalancerBackendAddresses" not in console.arm.resources[emp_pool_id.lower()]["properties"]

    keep_plan = review(console, ids=[lb_id], run=RUN2, includeRelated=True, mode="clone", clonePrefix="keep", backendPoolMode="keep")
    keep_pool = next(a for a in keep_plan["actions"] if a["resourceType"] == LB_POOL)
    assert keep_pool["warnings"]
    execute(console, keep_plan)
    keep_pool_id = SCOPE + "/providers/Microsoft.Network/loadBalancers/keep-capp-svc-lb/backendAddressPools/capp-svc-lbbepool"
    assert len(console.arm.resources[keep_pool_id.lower()]["properties"]["loadBalancerBackendAddresses"]) == 2


def test_https_only_pfx_gateway_falls_back_to_temporary_http_or_uses_keyvault_override(console):
    agw_id = SCOPE + "/providers/Microsoft.Network/applicationGateways/agw-https-only"
    console.arm.resources[SUBNET.lower()] = {
        "id": SUBNET, "name": "app", "type": VNET + "/subnets", "location": "koreacentral",
        "properties": {"provisioningState": "Succeeded", "addressPrefix": "10.0.1.0/24"},
    }
    agw = {
        "id": agw_id, "name": "agw-https-only", "type": AGW, "location": "koreacentral",
        "tags": copy.deepcopy(TAGS),
        "identity": {"type": "UserAssigned", "userAssignedIdentities": {
            SCOPE + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami": {},
        }},
        "properties": {
            "sku": {"name": "Standard_v2", "tier": "Standard_v2"},
            "gatewayIPConfigurations": [{"name": "gwip", "properties": {"subnet": {"id": SUBNET}}}],
            "frontendIPConfigurations": [{"name": "priv", "properties": {
                "privateIPAllocationMethod": "Static", "privateIPAddress": "10.0.1.10", "subnet": {"id": SUBNET},
            }}],
            "frontendPorts": [{"name": "p443", "properties": {"port": 443}}],
            "sslCertificates": [{"id": f"{agw_id}/sslCertificates/only-pfx", "name": "only-pfx",
                                 "properties": {"publicCertData": "MIIB"}}],
            "backendAddressPools": [{"name": "pool", "properties": {"backendAddresses": [{"ipAddress": "10.1.0.5"}]}}],
            "backendHttpSettingsCollection": [{"name": "bhs", "properties": {"port": 80, "protocol": "Http"}}],
            "httpListeners": [{"name": "https-lis", "properties": {
                "protocol": "Https",
                "frontendIPConfiguration": {"id": f"{agw_id}/frontendIPConfigurations/priv"},
                "frontendPort": {"id": f"{agw_id}/frontendPorts/p443"},
                "sslCertificate": {"id": f"{agw_id}/sslCertificates/only-pfx"},
            }}],
            "requestRoutingRules": [{"name": "https-rule", "properties": {
                "ruleType": "Basic", "priority": 100,
                "httpListener": {"id": f"{agw_id}/httpListeners/https-lis"},
                "backendAddressPool": {"id": f"{agw_id}/backendAddressPools/pool"},
                "backendHttpSettings": {"id": f"{agw_id}/backendHttpSettingsCollection/bhs"},
            }}],
        },
    }
    capture(console, [agw])

    # Without Key Vault secret override: downgrades HTTPS listener to temporary HTTP so clone succeeds!
    fallback_plan = review(
        console, ids=[agw_id], run=RUN2, mode="clone", clonePrefix="dr",
        overrides=[{"resourceId": agw_id, "path": "properties.frontendIPConfigurations[name=priv].properties.privateIPAddress", "value": "10.0.1.21"}],
    )
    assert any(adj["change"] == "placeholder" and "protocol" in adj["path"] for adj in fallback_plan["actions"][0]["adjustments"])
    fb_res = execute(console, fallback_plan)
    fb_agw = console.arm.resources[fb_res["resourceIds"][0].lower()]
    fb_lis = fb_agw["properties"]["httpListeners"][0]["properties"]
    assert fb_lis["protocol"] == "Http" and "sslCertificate" not in fb_lis

    # With pre-clone Key Vault secret override: preserves full HTTPS listener!
    kv_plan = review(
        console, ids=[agw_id], run=RUN2, mode="clone", clonePrefix="kv",
        overrides=[
            {"resourceId": agw_id, "path": "properties.frontendIPConfigurations[name=priv].properties.privateIPAddress", "value": "10.0.1.22"},
            {"resourceId": agw_id, "path": "properties.sslCertificates[name=only-pfx].properties.keyVaultSecretId",
             "value": "https://kv-sample.vault.azure.net/secrets/only-pfx"},
        ],
    )
    kv_res = execute(console, kv_plan)
    kv_agw = console.arm.resources[kv_res["resourceIds"][0].lower()]
    assert kv_agw["properties"]["httpListeners"][0]["properties"]["protocol"] == "Https"
    assert kv_agw["properties"]["sslCertificates"][0]["properties"]["keyVaultSecretId"] == "https://kv-sample.vault.azure.net/secrets/only-pfx"


def test_cross_subscription_and_region_clone_rebinds_shared_subnet_and_drops_empty_lb_pool_vnet(console):
    from test_resource_bundles import OTHER_GROUP, OTHER_SID, WAF, expand_targets

    from armbackup.azure_semantics import validate_subnet_ips

    src_vnet = resource(VNET, "vnet-src", {
        "addressSpace": {"addressPrefixes": ["10.0.0.0/16"]},
        "subnets": [{"name": "gw", "properties": {"addressPrefix": "10.0.1.0/24"}}],
    })
    src_sub_id = src_vnet["id"] + "/subnets/gw"
    dr_vnet_id = OTHER_GROUP + "/providers/Microsoft.Network/virtualNetworks/vnet-dr"
    dr_sub_id = dr_vnet_id + "/subnets/gw-dr"
    with pytest.raises(BackupError, match="대역"):
        validate_subnet_ips(AGW, {"properties": {"frontendIPConfigurations": [
            {"name": "priv", "properties": {"privateIPAllocationMethod": "Static",
                                            "privateIPAddress": "10.0.1.10", "subnet": {"id": dr_sub_id}}}]}},
            {dr_sub_id.lower(): ["10.20.1.0/24"]})
    validate_subnet_ips(AGW, {"properties": {"frontendIPConfigurations": [
        {"name": "priv", "properties": {"privateIPAllocationMethod": "Static",
                                        "privateIPAddress": "10.20.1.15", "subnet": {"id": dr_sub_id}}}]}},
        {dr_sub_id.lower(): ["10.20.1.0/24"]})

    expand_targets(console)
    console.arm.resources[src_sub_id.lower()] = {"id": src_sub_id, "name": "gw", "type": VNET + "/subnets",
                                                 "properties": {"provisioningState": "Succeeded", "addressPrefix": "10.0.1.0/24"}}
    console.arm.resources[dr_vnet_id.lower()] = {"id": dr_vnet_id, "name": "vnet-dr", "type": VNET, "location": "koreasouth",
                                                 "properties": {"provisioningState": "Succeeded", "subnets": [
                                                     {"id": dr_sub_id, "name": "gw-dr", "properties": {"provisioningState": "Succeeded", "addressPrefix": "10.20.1.0/24"}}]}}
    console.arm.resources[dr_sub_id.lower()] = {"id": dr_sub_id, "name": "gw-dr", "type": VNET + "/subnets",
                                                "properties": {"provisioningState": "Succeeded", "addressPrefix": "10.20.1.0/24"}}
    waf = resource(WAF, "waf-src", {"managedRules": {"managedRuleSets": [{"ruleSetType": "OWASP", "ruleSetVersion": "3.2"}]}})
    pip = resource(PIP, "pip-src", {"publicIPAllocationMethod": "Static", "publicIPAddressVersion": "IPv4",
                                    "dnsSettings": {"domainNameLabel": "app"}})
    pip["sku"] = {"name": "Standard"}
    agw = resource(AGW, "agw-src", {
        "sku": {"name": "WAF_v2", "tier": "WAF_v2"},
        "firewallPolicy": {"id": waf["id"]},
        "gatewayIPConfigurations": [{"name": "gwip", "properties": {"subnet": {"id": src_sub_id}}}],
        "frontendIPConfigurations": [
            {"name": "pub", "properties": {"publicIPAddress": {"id": pip["id"]}}},
        ],
    })
    pip_lb = resource(PIP, "pip-lb-src", {"publicIPAllocationMethod": "Static", "publicIPAddressVersion": "IPv4"})
    pip_lb["sku"] = {"name": "Standard"}
    lb, pool = lb_resources()
    lb["sku"] = {"name": "Standard"}
    lb["properties"]["frontendIPConfigurations"] = [{"name": "public", "properties": {"publicIPAddress": {"id": pip_lb["id"]}}}]
    pool["properties"]["virtualNetwork"] = {"id": src_vnet["id"]}
    lb["properties"]["backendAddressPools"] = [copy.deepcopy(pool)]
    capture(console, [waf, pip, agw, pip_lb, lb, pool])

    plan = review(
        console, ids=[agw["id"]], run=RUN2, mode="clone", includeRelated=True,
        targetSubscriptionId=OTHER_SID, targetResourceGroup="rg-dr", targetLocation="koreasouth",
        referenceBindings=[{"sourceId": src_sub_id, "targetId": dr_sub_id}],
        overrides=[
            {"resourceId": pip["id"], "path": "properties.dnsSettings.domainNameLabel", "value": "dr-app"},
        ],
    )
    agw_action = next(item for item in plan["actions"] if item["resourceType"] == AGW)
    assert any(adj["change"] == "rebound" for adj in agw_action["adjustments"])
    result = execute(console, plan, confirmGroup="")
    created_agw = console.arm.resources[agw_action["resourceId"].lower()]
    assert created_agw["location"] == "koreasouth"
    assert created_agw["properties"]["gatewayIPConfigurations"][0]["properties"]["subnet"]["id"] == dr_sub_id
    assert len(result["resourceIds"]) == 3

    lb_plan = review(
        console, ids=[lb["id"]], run=RUN2, mode="clone", includeRelated=True, clonePrefix="dr",
        targetSubscriptionId=OTHER_SID, targetResourceGroup="rg-dr", targetLocation="koreasouth",
    )
    pool_action = next(item for item in lb_plan["actions"] if item["resourceType"] == LB + "/backendaddresspools")
    assert any(adj["path"] == "properties.virtualNetwork" and adj["change"] == "dropped" for adj in pool_action["adjustments"])


def test_roadmap_compute_specs_cover_vm_and_vmss_mutability_and_power_states():
    from armbackup.azure_semantics import (
        DISK,
        EXCLUSIVE_TARGETS,
        NIC,
        RESOURCE_SPECS,
        VM,
        VMSS,
        inspect_runtime_state,
    )

    assert {NIC, DISK} <= EXCLUSIVE_TARGETS
    assert RESOURCE_SPECS[VM].stage == "roadmap" and RESOURCE_SPECS[VMSS].stage == "roadmap"
    snap_vm = {"location": "koreacentral", "zones": ["1"], "properties": {
        "hardwareProfile": {"vmSize": "Standard_D4s_v5"},
        "osProfile": {"computerName": "web-01", "adminUsername": "azureuser"},
    }}
    live_vm = {"location": "koreacentral", "zones": ["2"], "properties": {
        "hardwareProfile": {"vmSize": "Standard_D2s_v5"},
        "osProfile": {"computerName": "web-02", "adminUsername": "azureuser"},
        "instanceView": {"statuses": [{"code": "PowerState/running"}]},
    }}
    vm_conflicts = immutable_conflicts(VM, snap_vm, live_vm, live_vm)
    assert {item["path"] for item in vm_conflicts} == {"zones", "properties.osProfile.computerName"}
    block, warnings = inspect_runtime_state(VM, live_vm, "update", snapshot=snap_vm)
    assert block is None and any("재부팅" in w for w in warnings)
    host_change = copy.deepcopy(snap_vm)
    host_change["properties"]["proximityPlacementGroup"] = {"id": SCOPE + "/providers/Microsoft.Compute/proximityPlacementGroups/ppg1"}
    block_ppg, _ = inspect_runtime_state(VM, live_vm, "update", snapshot=host_change)
    assert block_ppg and "deallocated" in block_ppg

    vmss_conflicts = immutable_conflicts(
        VMSS,
        {"location": "koreacentral", "properties": {"orchestrationMode": "Uniform", "singlePlacementGroup": True}},
        {"location": "koreacentral", "properties": {"orchestrationMode": "Flexible", "singlePlacementGroup": False}},
    )
    by_path = {item["path"]: item["keepable"] for item in vmss_conflicts}
    assert by_path == {"properties.orchestrationMode": False, "properties.singlePlacementGroup": True}
