from __future__ import annotations

import argparse
from pathlib import Path

from azure.core.exceptions import AzureError

from armbackup.archive import BlobArchive
from armbackup.console import ConsoleConfig
from armbackup.contracts import BackupError, BrowseArchive, credential
from armbackup.http import ArmClient
from armbackup.local_archive import LocalArchive


def cleanup(path: Path, confirmation: str) -> None:
    config = ConsoleConfig.load(path)
    if confirmation != config.group:
        raise BackupError("Type the exact configured resource group name to confirm deletion")
    auth = credential(config.capture.credential, config.capture.client_id)
    arm = ArmClient(auth)
    archive: BrowseArchive
    if config.archive_mode == "local":
        if config.local_archive is None:
            raise BackupError("Explicit local archive path is missing")
        archive = LocalArchive(config.local_archive)
    else:
        archive = BlobArchive(config.capture, auth)
    with archive.guard("capture"):
        group = arm.request("GET", config.scope, "2021-04-01")
        if group.get("tags", {}).get("armbackupLab") != config.lab_id:
            raise BackupError("Resource group ownership changed; cleanup is blocked")
        for raw in arm.pages(config.scope + "/resources", "2021-04-01"):
            if raw.get("tags", {}).get("armbackupLab") != config.lab_id:
                raise BackupError("A resource without this lab ownership tag exists; inspect it before cleanup")
            if str(raw.get("type", "")).lower() == "microsoft.containerinstance/containergroups":
                raise BackupError("A private runner still exists; finish its cleanup before deleting the lab")
        arm.request("DELETE", config.scope, "2021-04-01")
    print(f"Deletion requested ONLY for {config.scope}. Local archives are preserved.")
    print("Confirm the resource group has disappeared in Azure; this request is asynchronous.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Delete only the explicitly owned, confirmed test RG")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--confirm-resource-group", required=True)
    args = parser.parse_args()
    try:
        cleanup(args.config, args.confirm_resource_group)
    except (BackupError, AzureError, OSError, ValueError) as exc:
        message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
        parser.exit(1, f"Lab cleanup stopped: {message}\n")


if __name__ == "__main__":
    main()
