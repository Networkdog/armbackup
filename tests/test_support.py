import copy

import pytest

from armbackup.contracts import BackupError
from armbackup.resource_profiles import AGW, LB, LB_POOL, PIP, WAF
from armbackup.support import (
    CATALOG,
    OFFICIAL_TYPES,
    restore_profile_reason,
    verify_backup_source,
    verify_official_capture,
    verify_official_configuration,
)


def gateway():
    return {"type": AGW, "properties": {"sku": {"name": "WAF_v2", "tier": "WAF_v2"},
            "httpListeners": [{"name": "http", "properties": {"protocol": "Http"}}],
            "backendHttpSettingsCollection": [{"name": "http", "properties": {"protocol": "Http", "port": 80}}]}}


def balancer():
    return {"type": LB, "sku": {"name": "Standard"}, "properties": {
        "frontendIPConfigurations": [{"name": "public", "properties": {
            "publicIPAddress": {"id": "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/ip"},
        }}],
        "loadBalancingRules": [{"name": "http", "properties": {"protocol": "Tcp", "frontendPort": 8080, "backendPort": 80}}],
    }}


def test_official_roots_are_fixed_prioritized_and_do_not_include_dependency_types():
    assert [entry["type"] for entry in CATALOG["resources"]] == [AGW, LB]
    assert OFFICIAL_TYPES == {AGW, LB}
    assert not {WAF, PIP, LB_POOL} & OFFICIAL_TYPES
    verify_official_configuration(gateway())
    verify_official_configuration(balancer())


@pytest.mark.parametrize("case", ["sku", "listener-tls", "backend-tls", "certificate", "identity", "http3", "private-frontend"])
def test_gateway_official_profile_rejects_untested_variants(case):
    raw = gateway()
    if case == "sku":
        raw["properties"]["sku"]["name"] = "Standard_v2"
    if case == "listener-tls":
        raw["properties"]["httpListeners"][0]["properties"]["protocol"] = "Https"
    if case == "backend-tls":
        raw["properties"]["backendHttpSettingsCollection"][0]["properties"]["protocol"] = "Https"
    if case == "certificate":
        raw["properties"]["sslCertificates"] = [{"name": "tls"}]
    if case == "identity":
        raw["identity"] = {"type": "SystemAssigned"}
    if case == "http3":
        raw["properties"]["httpListeners"][0]["properties"]["enableHttp3"] = True
    if case == "private-frontend":
        raw["properties"]["frontendIPConfigurations"] = [{"name": "private", "properties": {"privateIPAddress": "10.0.0.4"}}]
    with pytest.raises(BackupError):
        verify_official_configuration(raw)


@pytest.mark.parametrize("case", ["sku", "nat", "outbound", "udp", "private-frontend", "nic-pool", "unknown-field"])
def test_balancer_official_profile_rejects_untested_variants(case):
    raw = balancer()
    if case == "sku":
        raw["sku"]["name"] = "Gateway"
    if case == "nat":
        raw["properties"]["inboundNatRules"] = [{"name": "ssh"}]
    if case == "outbound":
        raw["properties"]["outboundRules"] = [{"name": "egress"}]
    if case == "udp":
        raw["properties"]["loadBalancingRules"][0]["properties"]["protocol"] = "Udp"
    if case == "private-frontend":
        raw["properties"]["frontendIPConfigurations"][0]["properties"] = {"privateIPAddress": "10.0.0.4"}
    if case == "nic-pool":
        raw["properties"]["backendAddressPools"] = [{"name": "pool", "properties": {"backendIPConfigurations": [{"id": "nic"}]}}]
    if case == "unknown-field":
        raw["properties"]["allocationPolicy"] = "unreviewed"
    with pytest.raises(BackupError):
        verify_official_configuration(raw)


def test_backup_accepts_every_untested_variant_and_only_restore_is_blocked():
    cases = []
    tls = gateway()
    tls["properties"]["httpListeners"][0]["properties"]["protocol"] = "Https"
    cases.append(tls)
    for field, value in (("outboundRules", [{"name": "egress"}]), ("inboundNatRules", [{"name": "ssh"}])):
        raw = balancer()
        raw["properties"][field] = value
        cases.append(raw)
    unknown = balancer()
    unknown["properties"]["allocationPolicy"] = "unreviewed"
    cases.append(unknown)
    for raw in cases:
        verify_backup_source(raw)
        assert restore_profile_reason(raw)
    assert restore_profile_reason(gateway()) == "" and restore_profile_reason(balancer()) == ""
    assert restore_profile_reason({"type": PIP}) == ""
    building = balancer()
    building["properties"]["provisioningState"] = "Updating"
    with pytest.raises(BackupError, match="stable"):
        verify_backup_source(building)
    with pytest.raises(BackupError):
        verify_backup_source({"type": PIP})


def test_capture_validation_rejects_a_changed_or_missing_public_ip_reference():
    raw = balancer()
    envelope = {"resourceType": LB, "resourceId": "/source", "captureApiVersion": "2024-05-01", "raw": raw}
    with pytest.raises(BackupError, match="required related"):
        verify_official_capture(envelope, {"/source"})
    identifier = raw["properties"]["frontendIPConfigurations"][0]["properties"]["publicIPAddress"]["id"]
    verify_official_capture(envelope, {"/source", identifier.lower()})
    changed = copy.deepcopy(envelope)
    changed["raw"]["properties"]["frontendIPConfigurations"][0]["properties"]["publicIPAddress"]["id"] = identifier + "-new"
    with pytest.raises(BackupError, match="required related"):
        verify_official_capture(changed, {"/source", identifier.lower()})


def test_capture_validation_requires_independent_backend_pool_snapshots():
    raw = balancer()
    raw["properties"]["backendAddressPools"] = [{"name": "http", "properties": {}}]
    identifier = raw["properties"]["frontendIPConfigurations"][0]["properties"]["publicIPAddress"]["id"]
    envelope = {"resourceType": LB, "resourceId": "/source", "captureApiVersion": "2024-05-01", "raw": raw}
    with pytest.raises(BackupError, match="independent"):
        verify_official_capture(envelope, {"/source", identifier.lower()})


def test_official_capture_requires_the_certified_api_version():
    with pytest.raises(BackupError, match="API version"):
        verify_official_capture({"resourceType": AGW, "captureApiVersion": "2025-01-01", "raw": gateway()}, set())


@pytest.mark.parametrize("kind", [AGW, LB])
def test_official_backup_rejects_in_progress_roots(kind):
    raw = gateway() if kind == AGW else balancer()
    raw["properties"]["provisioningState"] = "Updating"
    with pytest.raises(BackupError, match="stable"):
        verify_official_configuration(raw)
