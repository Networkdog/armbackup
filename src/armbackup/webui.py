from __future__ import annotations

import argparse
import base64
import hmac
import json
import os
import re
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from azure.core.exceptions import AzureError

from armbackup.config import keys
from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import BackupError, JsonObject, encode_json, object_value

ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.mjs": ("app.mjs", "text/javascript; charset=utf-8"),
    "/model.mjs": ("model.mjs", "text/javascript; charset=utf-8"),
    "/view-model.mjs": ("view-model.mjs", "text/javascript; charset=utf-8"),
    "/demo-data.mjs": ("demo-data.mjs", "text/javascript; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
    "/live-bootstrap.mjs": ("live-bootstrap.mjs", "text/javascript; charset=utf-8"),
    "/live-app.mjs": ("live-app.mjs", "text/javascript; charset=utf-8"),
    "/live-client.mjs": ("live-client.mjs", "text/javascript; charset=utf-8"),
    "/change-calendar.mjs": ("change-calendar.mjs", "text/javascript; charset=utf-8"),
    "/history-panel.mjs": ("history-panel.mjs", "text/javascript; charset=utf-8"),
    "/demo-history.mjs": ("demo-history.mjs", "text/javascript; charset=utf-8"),
    "/bundle-panel.mjs": ("bundle-panel.mjs", "text/javascript; charset=utf-8"),
    "/backup-view.mjs": ("backup-view.mjs", "text/javascript; charset=utf-8"),
    "/support-catalog.mjs": ("support-catalog.mjs", "text/javascript; charset=utf-8"),
    "/resource-support.json": ("resource-support.json", "application/json; charset=utf-8"),
}
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; "
    "img-src 'self'; connect-src 'self'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'"
)


class PreviewHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self._respond(body=True)

    def do_HEAD(self) -> None:
        self._respond(body=False)

    def _respond(self, *, body: bool) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            content = b'{"status":"ok","mode":"design-preview","azureConnected":false}'
            content_type = "application/json; charset=utf-8"
            status = 200
        elif path in ASSETS:
            name, content_type = ASSETS[path]
            content = files("armbackup").joinpath("ui_static", name).read_bytes()
            status = 200
        else:
            content, content_type, status = b"Not found", "text/plain; charset=utf-8", 404
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if body:
            self.wfile.write(content)


class ConsoleServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], console: LiveConsole, *,
                 hosted_host: str = "", operator_id: str = "", tenant_id: str = "") -> None:
        if hosted_host and (not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)?\.azurewebsites\.net", hosted_host)
                            or not all(re.fullmatch(r"[a-f0-9-]{36}", value) for value in (operator_id, tenant_id))
                            or console.config.archive_mode != "blob"):
            raise BackupError("Hosted console requires exact Azure hostname, tenant/operator and Blob archive")
        self.hosted_host, self.operator_id, self.tenant_id = hosted_host, operator_id, tenant_id
        self.console, self.session_token = console, secrets.token_urlsafe(32)
        super().__init__(address, ConsoleHandler)


class ConsoleHandler(PreviewHandler):
    server: ConsoleServer

    def _send(
        self, status: int, content: bytes, content_type: str, *, body: bool = True,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if body:
            self.wfile.write(content)

    def _json(self, data: JsonObject, status: int = 200, *, body: bool = True) -> None:
        self._send(status, encode_json(data), "application/json; charset=utf-8", body=body)

    def _trusted(self, *, session: bool = False) -> bool:
        host = self.server.hosted_host or f"127.0.0.1:{self.server.server_port}"
        scheme = "https" if self.server.hosted_host else "http"
        origin = self.headers.get("Origin")
        document_navigation = (
            bool(self.server.hosted_host)
            and self.command in {"GET", "HEAD"}
            and urlsplit(self.path).path in {"/", "/index.html"}
            and self.headers.get("Sec-Fetch-Mode") == "navigate"
            and self.headers.get("Sec-Fetch-Dest") == "document"
        )
        if (self.headers.get("Host") != host
                or (origin is not None and origin != f"{scheme}://{host}")
                or (self.headers.get("Sec-Fetch-Site") == "cross-site" and not document_navigation)):
            message = ("Only the configured console origin is allowed"
                       if self.server.hosted_host else "Only this loopback origin is allowed")
            self._json({"error": message}, 403)
            return False
        if self.server.hosted_host:
            try:
                encoded = self.headers.get("X-MS-CLIENT-PRINCIPAL", "")
                principal = object_value(json.loads(base64.b64decode(encoded, validate=True)), "hosted principal")
                claims = principal.get("claims", [])
                if not isinstance(claims, list):
                    raise ValueError("Invalid claims")
                identities = {claim.get("typ"): claim.get("val") for claim in claims if isinstance(claim, dict)}
                oid = identities.get("http://schemas.microsoft.com/identity/claims/objectidentifier") or identities.get("oid")
                tid = identities.get("http://schemas.microsoft.com/identity/claims/tenantid") or identities.get("tid")
                if principal.get("auth_typ") != "aad" or oid != self.server.operator_id or tid != self.server.tenant_id:
                    raise ValueError("Unapproved caller")
            except (ValueError, BackupError):
                self._json({"error": "An approved tenant operator must sign in"}, 403)
                return False
        if not session and not hmac.compare_digest(
            self.headers.get("X-Console-Token", ""), self.server.session_token,
        ):
            self._json({"error": "Console session is missing or expired; reload the page"}, 403)
            return False
        return True

    def _respond(self, *, body: bool) -> None:
        url = urlsplit(self.path)
        if self.server.hosted_host and url.path != "/health" and not self._trusted(session=True):
            return
        try:
            if url.path == "/health":
                self._json({"status": "ok", "mode": "live-lab", "scope": self.server.console.config.scope,
                            "azureConnected": True, "productionReady": False}, body=body)
            elif url.path.startswith("/api/"):
                if not self._trusted(session=url.path == "/api/session"):
                    return
                if not body:
                    self._json({}, body=False)
                    return
                parameters = parse_qs(url.query)
                console = self.server.console
                if url.path == "/api/session":
                    self._json({"mode": "live-lab", "sessionToken": self.server.session_token,
                                "workspace": console.public_context()})
                elif url.path == "/api/state":
                    state = console.initial_state(fresh=parameters.get("fresh", [""])[0] == "1")
                    self._json(state, 202 if state.get("statePending") else 200)
                elif url.path == "/api/state/refresh":
                    self._json(console.views.status(parameters.get("id", [""])[0]))
                elif url.path.startswith("/api/jobs/"):
                    self._json(console.job(url.path.rsplit("/", 1)[1]))
                elif url.path == "/api/report":
                    self._json(console.report(parameters.get("runId", [""])[0]))
                elif url.path == "/api/history":
                    self._json(console.change_history())
                elif url.path == "/api/history/detail":
                    self._json(console.change_detail(
                        parameters.get("beforeRunId", [""])[0],
                        parameters.get("afterRunId", [""])[0],
                        parameters.get("resourceId", [""])[0],
                    ))
                elif url.path == "/api/bundle":
                    self._json(console.bundle_graph(parameters.get("runId", [""])[0]))
                elif url.path == "/api/relations":
                    self._json(console.bundle_inventory())
                elif url.path == "/api/diagnostics":
                    self._json(console.troubleshoot(parameters.get("resourceId", [""])[0]))
                else:
                    self._json({"error": "Unknown API path"}, 404)
            elif url.path in {"/", "/index.html"}:
                page = files("armbackup").joinpath("ui_static", "index.html").read_text(encoding="utf-8")
                page = page.replace('src="/app.mjs"', 'src="/live-bootstrap.mjs"')
                page = page.replace("<body>", '<body class="live-console">')
                page = page.replace("LOCAL PREVIEW", "LIVE")
                page = page.replace("백업 현황 · armbackup", "MSP 작업 콘솔 · armbackup")
                page = page.replace("디자인 프리뷰 v1", "MSP 실환경 콘솔")
                page = page.replace("실제 Azure 미연결", "승인된 테스트 구독 · 운영 서비스 아님")
                page = page.replace("프리뷰 사용자", "로컬 운영자")
                page = page.replace('aria-label="프리뷰 안내"', 'aria-label="실환경 범위 안내"')
                page = page.replace("디자인 프리뷰를 불러오는 중입니다…", "실환경 연결을 준비하고 있습니다…")
                page = page.replace("로컬 브라우저 · 예시 모드", "서버 Azure 신원 · 단일 운영자")
                page = page.replace(
                    '<button class="sidebar-reset" id="reset-demo"><svg class="icon"><use href="#i-refresh"/></svg>예시 데이터 초기화</button>',
                    '<button class="sidebar-reset" id="reload-connection"><svg class="icon"><use href="#i-refresh"/></svg>연결 상태 새로고침</button>',
                )
                self._send(200, page.encode("utf-8"), "text/html; charset=utf-8", body=body)
            elif url.path in ASSETS:
                name, content_type = ASSETS[url.path]
                self._send(200, files("armbackup").joinpath("ui_static", name).read_bytes(),
                           content_type, body=body)
            else:
                self._json({"error": "Not found"}, 404, body=body)
        except (BackupError, AzureError, OSError, ValueError) as exc:
            message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
            self._json({"error": message, "code": type(exc).__name__,
                        "message": "No successful result was assumed; inspect scope and operation state"}, 400)

    def do_POST(self) -> None:
        if not self._trusted():
            return
        try:
            size = self.headers.get("Content-Length", "")
            if not size.isdecimal() or not 1 <= int(size) <= 32768:
                self._json({"error": "JSON request must be 1..32768 bytes"}, 413)
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
                self._json({"error": "Only application/json is supported"}, 415)
                return
            payload = object_value(json.loads(self.rfile.read(int(size))), "API request")
            path = urlsplit(self.path).path
            console = self.server.console
            if path == "/api/state/refresh":
                keys(payload, {"force"}, "state refresh")
                force = payload.get("force", False)
                if not isinstance(force, bool):
                    raise BackupError("State refresh force must be boolean")
                refresh = console.refresh_state(force=force)
                self._json(refresh, 202 if refresh["status"] == "Running" else 200)
            elif path == "/api/restore/review":
                self._json(console.prepare(payload))
            elif path == "/api/bundle/review":
                self._json(console.bundle_review(payload))
            elif path == "/api/logs":
                keys(payload, {"days", "level", "search"}, "log query")
                self._json(console.logs_reader.query(
                    days=payload.get("days", 7), level=payload.get("level", ""),
                    search=payload.get("search", ""),
                ))
            elif path in {"/api/backup", "/api/policy", "/api/restore", "/api/bundle-backup", "/api/bundle-restore"}:
                self._json(console.submit(path.rsplit("/", 1)[1], payload), 202)
            else:
                self._json({"error": "Unknown operation"}, 404)
        except (BackupError, AzureError, OSError, ValueError) as exc:
            message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
            self._json({"error": message, "code": type(exc).__name__}, 400)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Local-only armbackup UI design preview; no Azure")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--live-config", type=Path,
                        help="Explicit isolated Azure lab console; uses server-side credentials")
    parser.add_argument("--hosted", action="store_true", help="Entra EasyAuth protected App Service only")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be in 1..65535")
    console: LiveConsole | None = None
    try:
        if args.live_config:
            settings = ConsoleConfig.load(args.live_config)
            if args.hosted and (not os.environ.get("WEBSITE_SITE_NAME")
                                or not os.environ.get("WEBSITE_HOSTNAME") or settings.archive_mode != "blob"):
                raise BackupError("Hosted mode requires App Service and explicit Blob archive")
            console = LiveConsole.connect(settings)
            server: ThreadingHTTPServer = ConsoleServer(
                ("0.0.0.0" if args.hosted else "127.0.0.1", args.port), console,
                hosted_host=os.environ.get("WEBSITE_HOSTNAME", "") if args.hosted else "",
                operator_id=os.environ.get("ARMBACKUP_OPERATOR_ID", "") if args.hosted else "",
                tenant_id=os.environ.get("ARMBACKUP_TENANT_ID", "") if args.hosted else "",
            )
            console.views.start()
        else:
            if args.hosted:
                raise BackupError("Hosted preview is not supported; an approved live Blob config is required")
            server = ThreadingHTTPServer(("127.0.0.1", args.port), PreviewHandler)
    except (BackupError, AzureError, OSError, ValueError) as exc:
        if console:
            console.close()
        message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
        parser.exit(1, f"Console server could not start: {message}\n")
    mode = "LIVE isolated Azure lab" if console else "sample data; no Azure"
    print(f"armbackup console: http://127.0.0.1:{args.port} ({mode})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if console:
            console.close()


if __name__ == "__main__":
    main()
