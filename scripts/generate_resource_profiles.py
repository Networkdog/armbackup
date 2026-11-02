from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import urldefrag, urljoin

import requests

BASE = "https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification/"
NET = BASE + "network/resource-manager/Microsoft.Network/Network/stable/2024-05-01/"
CDN = BASE + "cdn/resource-manager/Microsoft.Cdn/Cdn/stable/2024-02-01/"
ROOTS = {
    "microsoft.network/virtualnetworks": (NET + "virtualNetwork.json", "VirtualNetwork"),
    "microsoft.network/applicationgateways": (NET + "applicationGateway.json", "ApplicationGateway"),
    "microsoft.network/loadbalancers": (NET + "loadBalancer.json", "LoadBalancer"),
    "microsoft.network/loadbalancers/backendaddresspools": (NET + "loadBalancer.json", "BackendAddressPool"),
    "microsoft.network/applicationgatewaywebapplicationfirewallpolicies": (NET + "webapplicationfirewall.json", "WebApplicationFirewallPolicy"),
    "microsoft.network/publicipaddresses": (NET + "publicIpAddress.json", "PublicIPAddress"),
    "microsoft.cdn/profiles": (CDN + "cdn.json", "Profile"),
    "microsoft.cdn/profiles/afdendpoints": (CDN + "afdx.json", "AFDEndpoint"),
    "microsoft.cdn/profiles/origingroups": (CDN + "afdx.json", "AFDOriginGroup"),
    "microsoft.cdn/profiles/origingroups/origins": (CDN + "afdx.json", "AFDOrigin"),
    "microsoft.cdn/profiles/afdendpoints/routes": (CDN + "afdx.json", "Route"),
    "microsoft.cdn/profiles/rulesets": (CDN + "afdx.json", "RuleSet"),
    "microsoft.cdn/profiles/rulesets/rules": (CDN + "afdx.json", "Rule"),
    "microsoft.cdn/profiles/securitypolicies": (CDN + "afdx.json", "SecurityPolicy"),
}


class Extractor:
    def __init__(self) -> None:
        self.documents: dict[str, dict] = {}
        self.nodes: dict[str, dict] = {}

    def document(self, url: str) -> dict:
        if not url.startswith(BASE):
            raise ValueError("Schema references must remain in the official specification repository")
        if url not in self.documents:
            response = requests.get(url, timeout=60)
            response.raise_for_status()
            self.documents[url] = response.json()
        return self.documents[url]

    def resolve(self, reference: str, current: str) -> tuple[dict, str, str]:
        url, fragment = urldefrag(urljoin(current, reference))
        data = self.document(url)
        for name in fragment.lstrip("/").split("/"):
            data = data[name]
        return data, url, url.removeprefix(BASE) + "#" + fragment

    def merged(self, schema: dict, current: str) -> tuple[dict, dict, list[str]]:
        properties = {}
        required = []
        metadata = {}
        for base in schema.get("allOf", []):
            if "$ref" in base:
                source, url, _ = self.resolve(base["$ref"], current)
            else:
                source, url = base, current
            extra, info, must = self.merged(source, url)
            properties.update(extra)
            metadata.update(info)
            required.extend(must)
        properties.update({name: (value, current) for name, value in schema.get("properties", {}).items()})
        metadata.update({key: schema[key] for key in ("type", "discriminator", "additionalProperties") if key in schema})
        required.extend(schema.get("required", []))
        return properties, metadata, required

    def node(self, schema: dict, current: str) -> dict:
        if "$ref" in schema:
            source, url, identifier = self.resolve(schema["$ref"], current)
            if identifier not in self.nodes:
                self.nodes[identifier] = {}
                self.nodes[identifier] = self.node(source, url)
            return {"ref": identifier}
        fields, metadata, required = self.merged(schema, current)
        if fields:
            writable = {}
            readonly = []
            for name, (field, url) in fields.items():
                if field.get("readOnly") is True:
                    readonly.append(name)
                else:
                    writable[name] = self.node(field, url)
                    if field.get("x-ms-secret") is True:
                        writable[name]["secret"] = True
            result = {"type": "object", "fields": writable, "readonly": sorted(readonly),
                      "required": sorted(set(required) - set(readonly))}
            additional = metadata.get("additionalProperties")
            if isinstance(additional, dict):
                result["additional"] = self.node(additional, current)
            elif additional is True:
                result["additional"] = {"type": "any"}
            discriminator = schema.get("discriminator")
            if isinstance(discriminator, str):
                variants = {}
                for name, candidate in self.document(current).get("definitions", {}).items():
                    props, _, _ = self.merged(candidate, current)
                    field = props.get(discriminator)
                    if field is None:
                        continue
                    values = field[0].get("enum", [])
                    discriminator_value = candidate.get("x-ms-discriminator-value")
                    if not isinstance(discriminator_value, str):
                        discriminator_value = values[0] if len(values) == 1 else None
                    if discriminator_value:
                        identifier = current.removeprefix(BASE) + "#/definitions/" + name
                        if identifier not in self.nodes:
                            self.nodes[identifier] = {}
                            self.nodes[identifier] = self.node(candidate, current)
                        variants[discriminator_value] = identifier
                result["discriminator"] = discriminator
                result["variants"] = variants
            return result
        kind = schema.get("type", metadata.get("type", "any"))
        if kind == "array":
            return {"type": "array", "items": self.node(schema.get("items", {}), current)}
        if kind == "object":
            additional = schema.get("additionalProperties", {})
            return {"type": "object", "fields": {}, "readonly": [], "required": [],
                    "additional": self.node(additional, current) if isinstance(additional, dict) else {"type": "any"}}
        return {"type": kind}

    def extract(self) -> dict:
        roots = {}
        for rtype, (url, definition) in ROOTS.items():
            roots[rtype] = self.node({"$ref": "#/definitions/" + definition}, url)
        return {"schemaVersion": 1, "source": "Azure REST API specification writable-field facts",
                "versions": {"Microsoft.Network": "2024-05-01", "Microsoft.Cdn": "2024-02-01"},
                "roots": roots, "nodes": self.nodes}


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract factual writable/read-only API field contracts")
    parser.add_argument("--output", type=Path, default=Path("src") / "armbackup" / "resource_profiles.json")
    args = parser.parse_args()
    data = Extractor().extract()
    args.output.write_text(json.dumps(data, sort_keys=True, indent=2), encoding="utf-8")
    print(f"Generated {len(data['roots'])} reviewed API roots and {len(data['nodes'])} field nodes")


if __name__ == "__main__":
    main()
