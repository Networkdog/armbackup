# ruff: noqa: F811
import copy

import pytest
from test_console import SCOPE
from test_resource_bundles import (  # noqa: F401
    AGW,
    LB,
    PIP,
    RUN2,
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
from armbackup.resource_profiles import VNET, restore_body

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


def test_update_refuses_immutable_difference_unless_current_value_is_kept(console):
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static", "publicIPAddressVersion": "IPv4"})
    capture(console, [pip])
    console.arm.resources[pip["id"].lower()]["location"] = "koreasouth"
    with pytest.raises(BackupError, match="location"):
        review(console, ids=[pip["id"]], run=RUN2, mode="update")
    plan = review(console, ids=[pip["id"]], run=RUN2, mode="update", immutableConflict="keep-current")
    assert plan["actions"][0]["adjustments"][0]["change"] == "kept-current"
    execute(console, plan)
    puts = [call for call in console.arm.calls if call[0] == "PUT"]
    assert puts[-1][3]["location"] == "koreasouth"
    with pytest.raises(BackupError, match="only applies to update"):
        review(console, ids=[pip["id"]], run=RUN2, mode="clone", clonePrefix="twin", immutableConflict="keep-current")


def test_vnet_update_never_silently_deletes_a_subnet_that_is_not_in_the_backup(console):
    hub, _ = vnet_pair()
    capture(console, [hub])
    live = console.arm.resources[hub["id"].lower()]
    live["properties"]["subnets"].append({"name": "later", "properties": {"addressPrefix": "10.0.2.0/24"}})
    with pytest.raises(BackupError, match="later"):
        review(console, ids=[hub["id"]], run=RUN2, mode="update")


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


def test_overrides_belong_to_clone_mode_and_to_selected_resources(console):
    pip = resource(PIP, "public", {"publicIPAllocationMethod": "Static"})
    capture(console, [pip])
    change = [{"resourceId": pip["id"], "path": "tags.a", "value": "b"}]
    with pytest.raises(BackupError, match="only allowed for clone"):
        review(console, ids=[pip["id"]], run=RUN2, mode="update", overrides=change)
    with pytest.raises(BackupError, match="not part of this clone"):
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
