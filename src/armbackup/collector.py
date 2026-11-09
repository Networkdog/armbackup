from __future__ import annotations

import argparse
import logging
import threading
import uuid
from pathlib import Path

from azure.core.exceptions import AzureError

from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import BackupError, JsonObject, encode_json, utc_now
from armbackup.state_view import FRESH_SECONDS

LOGGER = logging.getLogger(__name__)
BUSY_RETRY_SECONDS = 15.0


def collect_once(console: LiveConsole) -> JsonObject:
    view = console.state_view()
    record = {"id": str(uuid.uuid4()), "status": "Running", "startedAt": utc_now()}
    view.record_collection(record)
    try:
        console.verify_connection()
        state = console.views.wait(console.views.request(force=True))
    except Exception as exc:
        LOGGER.exception("Snapshot collection failed; preserving the last published view")
        if isinstance(exc, BackupError):
            message = str(exc)
        elif isinstance(exc, (AzureError, OSError, ValueError)):
            message = type(exc).__name__
        else:
            message = "Unexpected collector error; inspect the App Service log"
        view.record_collection({
            **record, "status": "Failed", "finishedAt": utc_now(),
            "error": message, "errorCode": type(exc).__name__,
        })
        raise
    view.record_collection({
        **record, "status": "Succeeded", "finishedAt": utc_now(),
        "observedAt": state["observedAt"], "sha256": state["materializedView"]["sha256"],
    })
    return state


class SnapshotScheduler:
    """Publishes UI snapshots from a background thread so no HTTP request waits on Azure."""

    def __init__(self, console: LiveConsole, *, interval: float = float(FRESH_SECONDS),
                 busy_retry: float = BUSY_RETRY_SECONDS) -> None:
        self.console, self.interval, self.busy_retry = console, interval, busy_retry
        self.stop = threading.Event()
        self.wakeup = threading.Event()
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.status: JsonObject = {"state": "Starting"}

    def start(self) -> None:
        if self.thread is not None:
            return
        self.thread = threading.Thread(target=self._loop, name="armbackup-snapshot", daemon=True)
        self.thread.start()

    def wake(self) -> None:
        self.wakeup.set()

    def snapshot(self) -> JsonObject:
        with self.lock:
            return dict(self.status)

    def _set(self, **values: str) -> None:
        with self.lock:
            self.status = dict(values)

    def _loop(self) -> None:
        delay = 0.0
        while True:
            self.wakeup.wait(delay)
            if self.stop.is_set():
                return
            self.wakeup.clear()
            if self.console.operation_running():
                delay = self.busy_retry
                continue
            delay = self.interval
            self._set(state="Running", startedAt=utc_now())
            try:
                state = collect_once(self.console)
            except Exception as exc:
                self._set(state="Failed", finishedAt=utc_now(), errorCode=type(exc).__name__)
                print(encode_json({"Event": "snapshot_collection_failed",
                                   "ErrorCode": type(exc).__name__}).decode(), flush=True)
                continue
            self._set(state="Succeeded", finishedAt=utc_now(), observedAt=str(state["observedAt"]))
            print(encode_json({"Event": "snapshot_published",
                               "ObservedAt": state["observedAt"]}).decode(), flush=True)

    def close(self) -> None:
        self.stop.set()
        self.wakeup.set()
        if self.thread is not None:
            self.thread.join(timeout=120)


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
