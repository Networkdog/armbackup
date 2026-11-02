from __future__ import annotations

import argparse
import json
import time
import uuid
from pathlib import Path

from azure.core.exceptions import AzureError

from armbackup.console import ConsoleConfig
from armbackup.contracts import ArmHttpError, BackupError, JsonObject, credential, encode_json
from armbackup.http import ArmClient

NET_API = "2024-05-01"
CDN_API = "2024-02-01"


def ready(arm: ArmClient, resource_id: str, api: str, *, attempts: int = 360) -> JsonObject:
    for _ in range(attempts):
        try:
            raw = arm.request("GET", resource_id, api)
        except ArmHttpError as exc:
            if exc.status != 404:
                raise
            time.sleep(5)
            continue
        state = raw.get("properties", {}).get("provisioningState", "Succeeded")
        if state == "Succeeded":
            return raw
        if state in {"Failed", "Canceled"}:
            raise BackupError(f"Provisioning failed: {resource_id.rsplit('/', 1)[-1]}")
        time.sleep(5)
    raise BackupError(f"Provisioning wait exceeded bound: {resource_id.rsplit('/', 1)[-1]}")


def provision(config_path: Path) -> None:
    config = ConsoleConfig.load(config_path)
    arm = ArmClient(credential(config.capture.credential, config.capture.client_id))
    root = config.scope
    group = arm.request("GET", root, "2021-04-01")
    if group.get("tags", {}).get("armbackupLab") != config.lab_id:
        raise BackupError("Complex test group ownership mismatch")
    location = group["location"]
    suffix = uuid.uuid5(uuid.NAMESPACE_URL, root).hex[:8]
    tags = {"armbackupLab": config.lab_id, "armbackupWorkload": "true",
            "purpose": "complex-validation", "environment": "lab", "customer": "customer-edge",
            "owner": "network-ops", "armbackupBundle": "edge-stack"}
    shared_tags = {**tags, "armbackupWorkload": "false", "armbackupBundle": "shared-test-backend"}
    desired: dict[str, JsonObject] = {}
    checkpoint = config_path.parent / "complex-resources.local.json"

    def save_checkpoint() -> None:
        checkpoint.write_bytes(encode_json({"scope": root, "status": "Provisioning", "desired": desired}))

    def create(name: str, rtype: str, body: JsonObject, api: str = NET_API) -> JsonObject:
        resource_id = root + "/providers/" + rtype + "/" + name
        desired[resource_id] = {"apiVersion": api, "body": body}
        save_checkpoint()
        try:
            old = arm.request("GET", resource_id, api)
        except ArmHttpError as exc:
            if exc.status != 404:
                raise
        else:
            if old.get("tags", {}).get("armbackupLab") != config.lab_id:
                raise BackupError("Existing complex test resource is not owned by this task")
            return old
        arm.request("PUT", resource_id, api, body)
        raw = ready(arm, resource_id, api)
        print(f"Ready: {name}", flush=True)
        return raw

    pip_nat = create("abx-nat-ip", "Microsoft.Network/publicIPAddresses", {
        "location": location, "tags": shared_tags, "sku": {"name": "Standard"},
        "properties": {"publicIPAllocationMethod": "Static", "publicIPAddressVersion": "IPv4"},
    })
    nat = create("abx-nat", "Microsoft.Network/natGateways", {
        "location": location, "tags": shared_tags, "sku": {"name": "Standard"},
        "properties": {"publicIpAddresses": [{"id": pip_nat["id"]}], "idleTimeoutInMinutes": 4},
    })
    backend_nsg = create("abx-backend-nsg", "Microsoft.Network/networkSecurityGroups", {
        "location": location, "tags": shared_tags, "properties": {"securityRules": [
            {"name": "allow-test-http", "properties": {
                "access": "Allow", "direction": "Inbound", "priority": 100, "protocol": "Tcp",
                "sourceAddressPrefix": "*", "sourcePortRange": "*", "destinationAddressPrefix": "*",
                "destinationPortRanges": ["80", "8080"],
            }},
        ]},
    })
    gateway_nsg = create("abx-gateway-nsg", "Microsoft.Network/networkSecurityGroups", {
        "location": location, "tags": shared_tags, "properties": {"securityRules": [
            {"name": "allow-client", "properties": {
                "access": "Allow", "direction": "Inbound", "priority": 100, "protocol": "Tcp",
                "sourceAddressPrefix": "*", "sourcePortRange": "*", "destinationAddressPrefix": "*",
                "destinationPortRanges": ["80", "8081", "8082"],
            }},
            {"name": "gateway-manager", "properties": {
                "access": "Allow", "direction": "Inbound", "priority": 110, "protocol": "Tcp",
                "sourceAddressPrefix": "GatewayManager", "sourcePortRange": "*",
                "destinationAddressPrefix": "*", "destinationPortRange": "65200-65535",
            }},
        ]},
    })
    vnet = create("abx-vnet", "Microsoft.Network/virtualNetworks", {
        "location": location, "tags": shared_tags, "properties": {
            "addressSpace": {"addressPrefixes": ["10.85.0.0/16"]},
            "subnets": [
                {"name": "containers", "properties": {
                    "addressPrefix": "10.85.1.0/24", "natGateway": {"id": nat["id"]},
                    "networkSecurityGroup": {"id": backend_nsg["id"]},
                    "delegations": [{"name": "aci", "properties": {"serviceName": "Microsoft.ContainerInstance/containerGroups"}}],
                }},
                {"name": "gateway", "properties": {"addressPrefix": "10.85.2.0/24",
                    "networkSecurityGroup": {"id": gateway_nsg["id"]},
                    "delegations": [{"name": "gateway", "properties": {"serviceName": "Microsoft.Network/applicationGateways"}}]}},
            ],
        },
    })
    gateway_subnet = vnet["id"] + "/subnets/gateway"
    arm.request("PUT", gateway_subnet, NET_API, {"properties": {
        "addressPrefix": "10.85.2.0/24", "networkSecurityGroup": {"id": gateway_nsg["id"]},
        "delegations": [{"name": "gateway", "properties": {"serviceName": "Microsoft.Network/applicationGateways"}}],
    }})
    ready(arm, gateway_subnet, NET_API)
    server_code = """
import threading,json
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  body=json.dumps({'service':'armbackup-test','port':self.server.server_port,'path':self.path}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
for port in (80,8080):
 threading.Thread(target=ThreadingHTTPServer(('0.0.0.0',port),Handler).serve_forever,daemon=True).start()
threading.Event().wait()
"""
    aci = create("abx-http-backend", "Microsoft.ContainerInstance/containerGroups", {
        "location": location, "tags": shared_tags, "properties": {
            "osType": "Linux", "restartPolicy": "Always",
            "subnetIds": [{"id": vnet["id"] + "/subnets/containers"}],
            "ipAddress": {"type": "Private", "ports": [{"port": 80, "protocol": "TCP"},
                                                       {"port": 8080, "protocol": "TCP"}]},
            "containers": [{"name": "http", "properties": {
                "image": "mcr.microsoft.com/azure-cli:latest", "command": ["python3", "-c", server_code],
                "resources": {"requests": {"cpu": 1, "memoryInGB": 1.5}},
                "ports": [{"port": 80}, {"port": 8080}],
            }}],
        },
    }, "2023-05-01")
    backend_ip = aci["properties"]["ipAddress"]["ip"]
    from provision_backend_vm import provision as provision_vm

    provision_vm(config_path)
    lb_ip = create("abx-lb-ip", "Microsoft.Network/publicIPAddresses", {
        "location": location, "tags": tags, "sku": {"name": "Standard"},
        "properties": {"publicIPAllocationMethod": "Static", "publicIPAddressVersion": "IPv4",
                       "dnsSettings": {"domainNameLabel": "abx-lb-" + suffix}},
    })
    lb_id = root + "/providers/Microsoft.Network/loadBalancers/abx-lb"
    lb = create("abx-lb", "Microsoft.Network/loadBalancers", {
        "location": location, "tags": tags, "sku": {"name": "Standard"},
        "properties": {
            "frontendIPConfigurations": [{"name": "public", "properties": {"publicIPAddress": {"id": lb_ip["id"]}}}],
            "backendAddressPools": [{"name": "http", "properties": {}}],
            "probes": [{"name": "tcp-health", "properties": {"protocol": "Tcp", "port": 80,
                                                               "intervalInSeconds": 5, "numberOfProbes": 2}}],
            "loadBalancingRules": [{"name": "http", "properties": {
                "frontendIPConfiguration": {"id": lb_id + "/frontendIPConfigurations/public"},
                "backendAddressPool": {"id": lb_id + "/backendAddressPools/http"},
                "probe": {"id": lb_id + "/probes/tcp-health"}, "protocol": "Tcp",
                "frontendPort": 8080, "backendPort": 80, "enableFloatingIP": False,
                "idleTimeoutInMinutes": 4, "enableTcpReset": True, "disableOutboundSnat": True,
            }}],
        },
    })
    pool_id = lb_id + "/backendAddressPools/http"
    pool_body: JsonObject = {"properties": {"loadBalancerBackendAddresses": [{
        "name": "vm-backend", "properties": {"ipAddress": "10.85.3.4", "virtualNetwork": {"id": vnet["id"]}},
    }]}}
    desired[pool_id] = {"apiVersion": NET_API, "body": pool_body}
    save_checkpoint()
    arm.request("PUT", pool_id, NET_API, pool_body)
    ready(arm, pool_id, NET_API)
    waf = create("abx-waf", "Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies", {
        "location": location, "tags": tags, "properties": {
            "policySettings": {"state": "Enabled", "mode": "Prevention", "requestBodyCheck": True},
            "managedRules": {"managedRuleSets": [{"ruleSetType": "OWASP", "ruleSetVersion": "3.2"}]},
            "customRules": [{"name": "BlockLabHeader", "priority": 10, "ruleType": "MatchRule", "action": "Block",
                             "matchConditions": [{"matchVariables": [{"variableName": "RequestHeaders", "selector": "X-Armbackup-Test"}],
                                                  "operator": "Contains", "matchValues": ["block"], "negationConditon": False}]}],
        },
    })
    agw_ip = create("abx-agw-ip", "Microsoft.Network/publicIPAddresses", {
        "location": location, "tags": tags, "sku": {"name": "Standard"},
        "properties": {"publicIPAllocationMethod": "Static", "publicIPAddressVersion": "IPv4",
                       "dnsSettings": {"domainNameLabel": "abx-agw-" + suffix}},
    })
    agw_id = root + "/providers/Microsoft.Network/applicationGateways/abx-agw"
    prefix = agw_id + "/"
    agw = create("abx-agw", "Microsoft.Network/applicationGateways", {
        "location": location, "tags": tags, "properties": {
            "sku": {"name": "WAF_v2", "tier": "WAF_v2"},
            "autoscaleConfiguration": {"minCapacity": 0, "maxCapacity": 2}, "enableHttp2": True,
            "firewallPolicy": {"id": waf["id"]}, "forceFirewallPolicyAssociation": True,
            "gatewayIPConfigurations": [{"name": "gateway", "properties": {"subnet": {"id": vnet["id"] + "/subnets/gateway"}}}],
            "frontendIPConfigurations": [{"name": "public", "properties": {"publicIPAddress": {"id": agw_ip["id"]}}}],
            "frontendPorts": [{"name": f"port-{port}", "properties": {"port": port}} for port in (80, 8081, 8082)],
            "backendAddressPools": [{"name": "http", "properties": {"backendAddresses": [{"ipAddress": backend_ip}]}}],
            "probes": [{"name": "health", "properties": {"protocol": "Http", "host": "backend.local", "path": "/health",
                                                         "interval": 10, "timeout": 10, "unhealthyThreshold": 3,
                                                         "match": {"statusCodes": ["200-399"]}}}],
            "backendHttpSettingsCollection": [
                {"name": name, "properties": {"port": port, "protocol": "Http", "cookieBasedAffinity": "Disabled",
                                               "requestTimeout": 20, "probe": {"id": prefix + "probes/health"}}}
                for name, port in (("normal", 80), ("api", 8080))
            ],
            "httpListeners": [{"name": f"listener-{port}", "properties": {
                "frontendIPConfiguration": {"id": prefix + "frontendIPConfigurations/public"},
                "frontendPort": {"id": prefix + f"frontendPorts/port-{port}"}, "protocol": "Http",
            }} for port in (80, 8081, 8082)],
            "urlPathMaps": [{"name": "api-paths", "properties": {
                "defaultBackendAddressPool": {"id": prefix + "backendAddressPools/http"},
                "defaultBackendHttpSettings": {"id": prefix + "backendHttpSettingsCollection/normal"},
                "pathRules": [{"name": "api", "properties": {
                    "paths": ["/api/*"], "backendAddressPool": {"id": prefix + "backendAddressPools/http"},
                    "backendHttpSettings": {"id": prefix + "backendHttpSettingsCollection/api"},
                }}],
            }}],
            "redirectConfigurations": [{"name": "to-main", "properties": {
                "redirectType": "Permanent", "targetListener": {"id": prefix + "httpListeners/listener-80"},
                "includePath": True, "includeQueryString": True,
            }}],
            "requestRoutingRules": [
                {"name": "normal", "properties": {"ruleType": "Basic", "priority": 100,
                     "httpListener": {"id": prefix + "httpListeners/listener-80"},
                     "backendAddressPool": {"id": prefix + "backendAddressPools/http"},
                     "backendHttpSettings": {"id": prefix + "backendHttpSettingsCollection/normal"}}},
                {"name": "api", "properties": {"ruleType": "PathBasedRouting", "priority": 110,
                     "httpListener": {"id": prefix + "httpListeners/listener-8081"},
                     "urlPathMap": {"id": prefix + "urlPathMaps/api-paths"}}},
                {"name": "redirect", "properties": {"ruleType": "Basic", "priority": 120,
                     "httpListener": {"id": prefix + "httpListeners/listener-8082"},
                     "redirectConfiguration": {"id": prefix + "redirectConfigurations/to-main"}}},
            ],
        },
    })
    profile_id = root + "/providers/Microsoft.Cdn/profiles/abx-frontdoor"
    profile = create("abx-frontdoor", "Microsoft.Cdn/profiles", {
        "location": "global", "tags": tags, "sku": {"name": "Standard_AzureFrontDoor"},
        "properties": {"originResponseTimeoutSeconds": 30},
    }, CDN_API)

    def child(path: str, body: JsonObject) -> JsonObject:
        desired[path] = {"apiVersion": CDN_API, "body": body}
        save_checkpoint()
        arm.request("PUT", path, CDN_API, body)
        return ready(arm, path, CDN_API)

    origin_group = child(profile_id + "/originGroups/http", {"properties": {
        "loadBalancingSettings": {"sampleSize": 4, "successfulSamplesRequired": 3, "additionalLatencyInMilliseconds": 50},
        "healthProbeSettings": {"probePath": "/health", "probeRequestType": "GET", "probeProtocol": "Http",
                                "probeIntervalInSeconds": 30},
    }})
    child(origin_group["id"] + "/origins/application-gateway", {"properties": {
        "hostName": agw_ip["properties"]["dnsSettings"]["fqdn"], "httpPort": 80, "httpsPort": 443,
        "originHostHeader": agw_ip["properties"]["dnsSettings"]["fqdn"],
        "priority": 1, "weight": 1000, "enabledState": "Enabled", "enforceCertificateNameCheck": True,
    }})
    endpoint = child(profile_id + "/afdEndpoints/abx-endpoint-" + suffix,
                     {"location": "global", "properties": {"enabledState": "Enabled"}})
    ruleset = child(profile_id + "/ruleSets/diagnostics", {"properties": {}})
    child(ruleset["id"] + "/rules/header", {"properties": {
        "order": 1, "conditions": [], "actions": [{"name": "ModifyResponseHeader", "parameters": {
            "typeName": "DeliveryRuleHeaderActionParameters", "headerAction": "Overwrite",
            "headerName": "X-Armbackup-Lab", "value": "restorable-edge",
        }}], "matchProcessingBehavior": "Continue",
    }})
    child(endpoint["id"] + "/routes/http", {"properties": {
        "originGroup": {"id": origin_group["id"]}, "ruleSets": [{"id": ruleset["id"]}],
        "supportedProtocols": ["Http", "Https"], "patternsToMatch": ["/*"],
        "forwardingProtocol": "HttpOnly", "linkToDefaultDomain": "Enabled",
        "httpsRedirect": "Enabled", "enabledState": "Enabled",
    }})
    output = {
        "scope": root, "createdAt": time.time(), "desired": desired,
        "edgeRoots": [lb["id"], agw["id"], profile["id"]],
        "edgeMembers": [identifier for identifier in desired if "/abx-lb" in identifier or "/abx-agw" in identifier
                        or identifier == waf["id"] or identifier.startswith(profile_id)],
        "shared": [vnet["id"], backend_nsg["id"], gateway_nsg["id"], aci["id"], nat["id"], pip_nat["id"],
                   root + "/providers/Microsoft.Compute/virtualMachines/abx-http-vm",
                   root + "/providers/Microsoft.Network/networkInterfaces/abx-vm-nic"],
        "addresses": {"loadBalancer": f"http://{lb_ip['properties']['ipAddress']}:8080",
                      "applicationGateway": "http://" + agw_ip["properties"]["ipAddress"],
                      "frontDoor": "https://" + endpoint["properties"]["hostName"]},
    }
    (config_path.parent / "complex-resources.local.json").write_bytes(encode_json(output))
    print(json.dumps({"complexResources": len(desired), "scope": root,
                      "evidence": str(config_path.parent / "complex-resources.local.json")}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Only explicitly tagged complex networking tests in the approved RG")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    try:
        provision(args.config.resolve())
    except (BackupError, AzureError, OSError, ValueError) as exc:
        message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
        parser.exit(1, f"Complex provisioning stopped: {message}\n")


if __name__ == "__main__":
    main()
