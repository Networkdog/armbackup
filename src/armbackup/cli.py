from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from azure.core.exceptions import AzureError

from armbackup.archive import BlobArchive
from armbackup.backup import Backup, new_run_id
from armbackup.config import Config
from armbackup.contracts import BackupError, credential, digest, encode_json, object_value
from armbackup.events import LogAnalyticsEvents, verify_log_destination
from armbackup.http import ArmClient
from armbackup.restore import apply_plan, build_plan, load_snapshot


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Azure control-plane configuration capture")
    result.add_argument("--config", type=Path,
                        default=Path(os.environ.get("ARMBACKUP_CONFIG", "config.json")))
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("validate-config", help="Validate local settings without contacting Azure")
    commands.add_parser("backup", help="Discover, capture, store and log; never changes source resources")
    plan = commands.add_parser("restore-plan", help="Create a reviewed-type plan; no Azure writes")
    plan.add_argument("--run-id", required=True)
    plan.add_argument("--resource-id", required=True)
    plan.add_argument("--target-resource-id", required=True)
    plan.add_argument("--api-version", required=True)
    plan.add_argument("--reference-map", type=Path)
    plan.add_argument("--output", type=Path, required=True)
    apply = commands.add_parser("restore-apply", help="Explicitly apply an approved NSG/route-table plan")
    apply.add_argument("--plan", type=Path, required=True)
    apply.add_argument("--confirm-sha256", required=True)
    apply.add_argument("--allow-existing", action="store_true")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    events: LogAnalyticsEvents | None = None
    try:
        config = Config.load(args.config)
        if args.command == "validate-config":
            print("Configuration valid; Azure connectivity and permissions NOT tested.")
            return 0
        auth = credential(config.credential, config.client_id)
        arm = ArmClient(auth, retries=config.retries, timeout=config.timeout)
        run_id = new_run_id()
        verify_log_destination(config, arm)
        events = LogAnalyticsEvents(config, auth, run_id)
        if args.command == "backup":
            store = BlobArchive(config, auth)
            manifest = Backup(config, arm, store, events).run(run_id)
            print(json.dumps({"runId": run_id, "status": manifest["status"]}))
            return 0 if manifest["status"] == "Captured" else 2
        if args.command == "restore-plan":
            store = BlobArchive(config, auth)
            envelope = load_snapshot(store, args.run_id, args.resource_id)
            refs = object_value(json.loads(args.reference_map.read_text(encoding="utf-8")),
                                "reference map") if args.reference_map else {}
            if not all(isinstance(v, str) for v in refs.values()):
                raise BackupError("Reference mapping values must be resource IDs")
            plan = build_plan(envelope, args.target_resource_id, args.api_version, refs)
            with args.output.open("xb") as file:
                file.write(encode_json(plan))
            print(json.dumps({"plan": str(args.output), "approvalSha256": digest(encode_json(plan))}))
            return 0
        plan = object_value(json.loads(args.plan.read_text(encoding="utf-8")), "restore plan")
        outcome = apply_plan(plan, args.confirm_sha256, arm, events,
                             allow_existing=args.allow_existing)
        print(json.dumps(outcome))
        return 0
    except (BackupError, AzureError, OSError, ValueError) as exc:
        # SDK/IO exceptions may contain credentials or payloads; do not dump their text.
        message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
        print(json.dumps({"Event": "command_failed", "ErrorCode": type(exc).__name__,
                          "Message": message}), file=sys.stderr)
        if events:
            try:
                events.emit("command_failed", level="Error", status="Failed", code=type(exc).__name__)
                events.flush()
            except BackupError:
                print('{"Event":"failure_log_delivery_failed"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
