from __future__ import annotations

import argparse
import logging
import uuid
from pathlib import Path

from azure.core.exceptions import AzureError

from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import BackupError, JsonObject, encode_json, utc_now

LOGGER = logging.getLogger(__name__)


def collect_once(console: LiveConsole) -> JsonObject:
    view = console.state_view()
    record = {"id": str(uuid.uuid4()), "status": "Running", "startedAt": utc_now()}
    view.record_collection(record)
    try:
        console.verify_connection()
        state = console.views.wait(console.views.request(force=True))
    except (BackupError, AzureError, OSError, ValueError) as exc:
        LOGGER.exception("Scheduled snapshot collection failed; preserving the last published view")
        view.record_collection({
            **record, "status": "Failed", "finishedAt": utc_now(),
            "error": str(exc), "errorCode": type(exc).__name__,
        })
        raise
    view.record_collection({
        **record, "status": "Succeeded", "finishedAt": utc_now(),
        "observedAt": state["observedAt"], "sha256": state["materializedView"]["sha256"],
    })
    return state


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Publish one verified UI snapshot; no web server required")
    parser.add_argument("--console-config", type=Path, required=True)
    args = parser.parse_args(argv)
    console = LiveConsole.connect(ConsoleConfig.load(args.console_config), snapshot_only=True)
    try:
        state = collect_once(console)
        print(encode_json({"status": "Succeeded", "observedAt": state["observedAt"],
                           "materializedView": state["materializedView"]}).decode(), flush=True)
    finally:
        console.close()


if __name__ == "__main__":
    main()
