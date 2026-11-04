from __future__ import annotations

import argparse
import base64
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from provision_complex_lab import ready

from armbackup.console import ConsoleConfig
from armbackup.contracts import ArmHttpError, BackupError, credential
from armbackup.http import ArmClient


def provision(path: Path, *, config: ConsoleConfig | None = None) -> None:
    config = config or ConsoleConfig.load(path)
    arm = ArmClient(credential(config.capture.credential, config.capture.client_id))
    root = config.scope
    group = arm.request("GET", root, "2021-04-01")
    if group.get("tags", {}).get("armbackupLab") != config.lab_id:
        raise BackupError("Backend test ownership mismatch")
    location = group["location"]
    tags = {"armbackupLab": config.lab_id, "armbackupWorkload": "false",
            "armbackupBundle": "shared-test-backend", "purpose": "complex-validation"}
    for kind, name in (("virtualNetworks", "abx-vnet"), ("networkSecurityGroups", "abx-backend-nsg"),
                       ("natGateways", "abx-nat")):
        raw = arm.request("GET", root + "/providers/Microsoft.Network/" + kind + "/" + name,
                          "2024-05-01")
        if raw.get("tags", {}).get("armbackupLab") != config.lab_id:
            raise BackupError("Shared test dependency ownership mismatch")
    nic = root + "/providers/Microsoft.Network/networkInterfaces/abx-vm-nic"
    vm = root + "/providers/Microsoft.Compute/virtualMachines/abx-http-vm"
    for identifier, api in ((nic, "2024-05-01"), (vm, "2024-11-01")):
        try:
            raw = arm.request("GET", identifier, api)
        except ArmHttpError as exc:
            if exc.status != 404:
                raise
        else:
            if raw.get("tags", {}).get("armbackupLab") != config.lab_id:
                raise BackupError("Existing backend test resource is not owned")
            if identifier == vm:
                ready(arm, vm, api)
                print("Owned private backend VM already exists.")
                return
    subnet = root + "/providers/Microsoft.Network/virtualNetworks/abx-vnet/subnets/vm-backend"
    arm.request("PUT", subnet, "2024-05-01", {"properties": {
        "addressPrefix": "10.85.3.0/24",
        "networkSecurityGroup": {"id": root + "/providers/Microsoft.Network/networkSecurityGroups/abx-backend-nsg"},
        "natGateway": {"id": root + "/providers/Microsoft.Network/natGateways/abx-nat"},
    }})
    ready(arm, subnet, "2024-05-01")
    arm.request("PUT", nic, "2024-05-01", {
        "location": location, "tags": tags, "properties": {"ipConfigurations": [{
            "name": "private", "properties": {"subnet": {"id": subnet}, "privateIPAddress": "10.85.3.4",
                                              "privateIPAllocationMethod": "Static"},
        }]},
    })
    ready(arm, nic, "2024-05-01")
    code = """import threading,json
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  b=json.dumps({'service':'armbackup-test','port':self.server.server_port,'path':self.path}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
for p in (80,8080):
 threading.Thread(target=ThreadingHTTPServer(('0.0.0.0',p),H).serve_forever,daemon=True).start()
threading.Event().wait()
"""
    encoded = base64.b64encode(code.encode()).decode()
    cloud_init = f"""#cloud-config
runcmd:
  - [bash, -c, "echo {encoded} | base64 -d > /opt/armbackup-http.py; nohup python3 /opt/armbackup-http.py >/var/log/armbackup-http.log 2>&1 &"]
"""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = key.public_key().public_bytes(
        serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH,
    ).decode("ascii")
    arm.request("PUT", vm, "2024-11-01", {
        "location": location, "tags": tags,
        "properties": {
            "hardwareProfile": {"vmSize": "Standard_B1s"},
            "storageProfile": {
                "imageReference": {"publisher": "Canonical", "offer": "0001-com-ubuntu-server-jammy",
                                   "sku": "22_04-lts-gen2", "version": "latest"},
                "osDisk": {"name": "abx-http-osdisk", "createOption": "FromImage",
                           "managedDisk": {"storageAccountType": "Standard_LRS"}},
            },
            "osProfile": {"computerName": "abx-http", "adminUsername": "labadmin",
                          "customData": base64.b64encode(cloud_init.encode()).decode(),
                          "linuxConfiguration": {"disablePasswordAuthentication": True,
                              "ssh": {"publicKeys": [{"path": "/home/labadmin/.ssh/authorized_keys",
                                                     "keyData": public_key}]}}},
            "networkProfile": {"networkInterfaces": [{"id": nic, "properties": {"primary": True}}]},
        },
    })
    ready(arm, vm, "2024-11-01")
    print("Temporary private backend VM ready; no public IP/SSH endpoint and no credential persisted.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Private short-lived LB test backend; never a restore target")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    provision(args.config.resolve())


if __name__ == "__main__":
    main()
