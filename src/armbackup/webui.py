from __future__ import annotations

import argparse
import base64
import hmac
import html
import json
import os
import re
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from azure.core.exceptions import AzureError

from armbackup import auth as auth_module
from armbackup.auth import SESSION_COOKIE, LoginBlocked, PasswordAuthenticator, load_auth
from armbackup.collector import SnapshotScheduler
from armbackup.config import keys
from armbackup.console import ConsoleConfig, LiveConsole
from armbackup.contracts import BackupError, JsonObject, encode_json, object_value
from armbackup.schedule import BackupScheduler

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
    "/admin-panel.mjs": ("admin-panel.mjs", "text/javascript; charset=utf-8"),
    "/notifications.mjs": ("notifications.mjs", "text/javascript; charset=utf-8"),
    "/sidebar-collapse.mjs": ("sidebar-collapse.mjs", "text/javascript; charset=utf-8"),
    "/change-calendar.mjs": ("change-calendar.mjs", "text/javascript; charset=utf-8"),
    "/history-panel.mjs": ("history-panel.mjs", "text/javascript; charset=utf-8"),
    "/backup-calendar.mjs": ("backup-calendar.mjs", "text/javascript; charset=utf-8"),
    "/demo-history.mjs": ("demo-history.mjs", "text/javascript; charset=utf-8"),
    "/bundle-panel.mjs": ("bundle-panel.mjs", "text/javascript; charset=utf-8"),
    "/backup-view.mjs": ("backup-view.mjs", "text/javascript; charset=utf-8"),
    "/restore-target.mjs": ("restore-target.mjs", "text/javascript; charset=utf-8"),
    "/support-catalog.mjs": ("support-catalog.mjs", "text/javascript; charset=utf-8"),
    "/resource-support.json": ("resource-support.json", "application/json; charset=utf-8"),
}
# Sample-data modules exist only for the loopback design preview; a live/hosted console never serves them.
DEMO_ASSETS = frozenset({"/app.mjs", "/model.mjs", "/demo-data.mjs", "/demo-history.mjs"})
# Served before sign-in when ARMBACKUP_AUTH_MODE=password; everything else needs a valid session.
LOGIN_ASSETS = {
    "/login": ("login.html", "text/html; charset=utf-8"),
    "/login.mjs": ("login.mjs", "text/javascript; charset=utf-8"),
}
PUBLIC_PATHS = frozenset({*LOGIN_ASSETS, "/styles.css", "/favicon.svg"})
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; "
    "img-src 'self'; connect-src 'self'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'"
)


class PreviewHandler(BaseHTTPRequestHandler):
    # The App Service auth proxy reuses upstream connections. An HTTP/1.0 server closes the socket
    # after every response, so under concurrency the proxy sometimes writes its next request to a
    # socket that is already closing and answers an empty HTTP 500 without the request ever reaching
    # this process. Persistent HTTP/1.1 connections avoid that race. The idle timeout stays above
    # the platform's idle limits so the proxy, not this server, closes idle connections first.
    protocol_version = "HTTP/1.1"
    timeout = 650

    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        lengths = self.headers.get_all("Content-Length", [])
        chunked = "Transfer-Encoding" in self.headers
        # Only POST bodies are read. Any other body, a chunked body or conflicting lengths would be
        # parsed as the next request on a reused connection, so such connections are closed.
        if (chunked or len(lengths) > 1
                or (self.command != "POST" and any(value.strip() != "0" for value in lengths))):
            self.close_connection = True
        return True

    def do_GET(self) -> None:
        self._respond(body=True)

    def do_HEAD(self) -> None:
        self._respond(body=False)

    def _start_response(
        self, status: int, content_type: str, length: int, headers: tuple[tuple[str, str], ...] = (),
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for name, value in headers:
            self.send_header(name, value)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()

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
        self._start_response(status, content_type, len(content))
        if body:
            self.wfile.write(content)


class BurstTolerantServer(ThreadingHTTPServer):
    # A page load sends ~12 module requests at once through the auth proxy; keep the listen
    # backlog well above the http.server default of 5 so bursts are queued, not refused.
    request_queue_size = 128


class ConsoleServer(BurstTolerantServer):
    def __init__(self, address: tuple[str, int], console: LiveConsole, *,
                 hosted_host: str = "", operator_id: str = "", tenant_id: str = "",
                 password_auth: PasswordAuthenticator | None = None) -> None:
        if hosted_host and (not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)?\.azurewebsites\.net", hosted_host)
                            or (password_auth is None
                                and not all(re.fullmatch(r"[a-f0-9-]{36}", value) for value in (operator_id, tenant_id)))
                            or console.config.archive_mode != "blob"):
            raise BackupError("Hosted console requires exact Azure hostname, tenant/operator and Blob archive")
        if hosted_host and password_auth is None and not auth_module.ENTRA_ENABLED:
            raise BackupError("Entra sign-in is temporarily disabled; the hosted console requires password sign-in")
        if password_auth is not None and not hosted_host:
            raise BackupError("Password sign-in is only available for the hosted HTTPS console")
        self.hosted_host, self.operator_id, self.tenant_id = hosted_host, operator_id, tenant_id
        self.password_auth = password_auth
        self.collector: SnapshotScheduler | None = None
        self.build = ""
        self.console, self.session_token = console, secrets.token_urlsafe(32)
        super().__init__(address, ConsoleHandler)


class ConsoleHandler(PreviewHandler):
    server: ConsoleServer

    def _send(
        self, status: int, content: bytes, content_type: str, *, body: bool = True,
        headers: tuple[tuple[str, str], ...] = (),
    ) -> None:
        self._start_response(status, content_type, len(content), headers)
        if body:
            self.wfile.write(content)

    def _json(self, data: JsonObject, status: int = 200, *, body: bool = True,
              headers: tuple[tuple[str, str], ...] = ()) -> None:
        self._send(status, encode_json(data), "application/json; charset=utf-8", body=body, headers=headers)

    def _session_cookie(self) -> str:
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == SESSION_COOKIE:
                return value
        return ""

    def _signed_in(self) -> bool:
        auth = self.server.password_auth
        token = self._session_cookie()
        return auth is not None and bool(token) and auth.validate(token)

    def _client_address(self) -> str:
        # App Service appends the real client (ip:port) as the last X-Forwarded-For entry.
        forwarded = self.headers.get("X-Forwarded-For", "").rsplit(",", 1)[-1].strip()
        host = forwarded.rsplit(":", 1)[0] if forwarded.count(":") == 1 else forwarded
        return host[:64] or self.client_address[0]

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()

    def _sign_in_required(self) -> None:
        path = urlsplit(self.path).path
        if self.command in {"GET", "HEAD"} and path in {"/", "/index.html"}:
            self._redirect("/login")
        else:
            self._json({"error": "Sign in required", "loginUrl": "/login"}, 401)

    def _cookie_header(self, token: str) -> tuple[str, str]:
        # __Host- requires Secure, Path=/ and no Domain; SameSite=Strict keeps the cookie off cross-site requests.
        return "Set-Cookie", f"{SESSION_COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Strict" + (
            "" if token else "; Max-Age=0")

    def _trusted(self, *, session: bool = False, origin_only: bool = False) -> bool:
        host = self.server.hosted_host or f"127.0.0.1:{self.server.server_port}"
        scheme = "https" if self.server.hosted_host else "http"
        origin = self.headers.get("Origin")
        document_navigation = (
            bool(self.server.hosted_host)
            and self.command in {"GET", "HEAD"}
            and urlsplit(self.path).path in {"/", "/index.html", "/login"}
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
        if origin_only:
            return True
        if self.server.password_auth is not None:
            if not self._signed_in():
                self._sign_in_required()
                return False
        elif self.server.hosted_host:
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
        public = self.server.password_auth is not None and url.path in PUBLIC_PATHS
        if self.server.hosted_host and url.path != "/health" and not self._trusted(
                session=True, origin_only=public):
            return
        try:
            if url.path == "/health":
                health: JsonObject = {
                    "status": "ok", "mode": "live-lab", "scope": self.server.console.config.scope,
                    "azureConnected": True, "productionReady": False}
                if self.server.build:
                    health["build"] = self.server.build[:12]
                if self.server.collector is not None:
                    health["collector"] = self.server.collector.snapshot()
                self._json(health, body=body)
            elif url.path.startswith("/api/"):
                if not self._trusted(session=url.path == "/api/session"):
                    return
                if not body:
                    self._json({}, body=False)
                    return
                parameters = parse_qs(url.query)
                console = self.server.console
                if url.path == "/api/session":
                    auth: JsonObject = {"mode": "password" if self.server.password_auth else "entra"}
                    if self.server.password_auth:
                        auth["user"] = self.server.password_auth.username
                    self._json({"mode": "live-lab", "sessionToken": self.server.session_token,
                                "workspace": console.public_context(), "auth": auth})
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
                elif url.path == "/api/restore-targets":
                    self._json(console.restore_targets(parameters.get("subscriptionId", [""])[0]))
                elif url.path == "/api/admin":
                    self._json(console.admin_status())
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
                page = page.replace("프리뷰 사용자", "로컬 운영자")
                page = page.replace('aria-label="프리뷰 안내"', 'aria-label="실환경 범위 안내"')
                page = page.replace("로컬 브라우저 · 예시 모드", "서버 Azure 신원 · 단일 운영자")
                initial = "L"
                if self.server.password_auth is not None:
                    initial = html.escape(self.server.password_auth.username[0].upper())
                    page = page.replace("로컬 운영자", html.escape(self.server.password_auth.username))
                    page = page.replace(
                        '<div class="sidebar-user">',
                        '<button class="sidebar-reset" id="logout"><svg class="icon"><use href="#i-arrow"/></svg><span class="side-label">로그아웃</span></button>'
                        '<div class="sidebar-user">')
                page = page.replace('<span class="avatar">P</span>', f'<span class="avatar">{initial}</span>')
                page = page.replace(
                    '<button class="sidebar-reset" id="reset-demo"><svg class="icon"><use href="#i-refresh"/></svg><span class="side-label">예시 데이터 초기화</span></button>',
                    '<button class="sidebar-reset" id="reload-connection"><svg class="icon"><use href="#i-refresh"/></svg><span class="side-label">연결 상태 새로고침</span></button>',
                )
                self._send(200, page.encode("utf-8"), "text/html; charset=utf-8", body=body)
            elif url.path in LOGIN_ASSETS and self.server.password_auth is not None:
                if url.path == "/login" and self._signed_in():
                    self._redirect("/")
                    return
                name, content_type = LOGIN_ASSETS[url.path]
                self._send(200, files("armbackup").joinpath("ui_static", name).read_bytes(),
                           content_type, body=body)
            elif url.path in ASSETS and url.path not in DEMO_ASSETS:
                name, content_type = ASSETS[url.path]
                self._send(200, files("armbackup").joinpath("ui_static", name).read_bytes(),
                           content_type, body=body)
            else:
                self._json({"error": "Not found"}, 404, body=body)
        except (BackupError, AzureError, OSError, ValueError) as exc:
            message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
            self._json({"error": message, "code": type(exc).__name__,
                        "message": "No successful result was assumed; inspect scope and operation state"}, 400)

    def _login(self, auth: PasswordAuthenticator, payload: JsonObject) -> None:
        keys(payload, {"username", "password"}, "login")
        username, password = payload.get("username"), payload.get("password")
        if (not isinstance(username, str) or not isinstance(password, str)
                or not 1 <= len(username) <= 128 or not 1 <= len(password) <= 1024):
            self._json({"error": "Invalid username or password"}, 401)
            return
        client = self._client_address()
        try:
            token = auth.login(username, password, client)
        except LoginBlocked as blocked:
            print(encode_json({"Event": "auth_login_blocked", "client": client}), flush=True)
            self._json({"error": "Too many failed sign-in attempts; try again later"}, 429,
                       headers=(("Retry-After", str(blocked.retry_after)),))
            return
        # The submitted username is never logged: operators sometimes type the password into that field.
        print(encode_json({"Event": "auth_login_succeeded" if token else "auth_login_failed",
                           "client": client}), flush=True)
        if token is None:
            self._json({"error": "Invalid username or password"}, 401)
        else:
            self._json({"ok": True}, headers=(self._cookie_header(token),))

    def do_POST(self) -> None:
        keep_alive = not self.close_connection
        # Until the request body is consumed the socket must not be reused for another request.
        self.close_connection = True
        login = self.server.password_auth is not None and urlsplit(self.path).path == "/api/login"
        if not self._trusted(origin_only=login):
            return
        try:
            if "Transfer-Encoding" in self.headers or len(self.headers.get_all("Content-Length", [])) > 1:
                self._json({"error": "Unsupported request framing"}, 400)
                return
            size = self.headers.get("Content-Length", "")
            if not size.isdecimal() or not 1 <= int(size) <= 32768:
                self._json({"error": "JSON request must be 1..32768 bytes"}, 413)
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
                self._json({"error": "Only application/json is supported"}, 415)
                return
            raw = self.rfile.read(int(size))
            self.close_connection = not keep_alive
            payload = object_value(json.loads(raw), "API request")
            path = urlsplit(self.path).path
            console = self.server.console
            auth = self.server.password_auth
            if auth is not None and path == "/api/login":
                self._login(auth, payload)
            elif auth is not None and path == "/api/logout":
                keys(payload, set(), "logout")
                auth.logout(self._session_cookie())
                self._json({"ok": True}, headers=(self._cookie_header(""),))
            elif path == "/api/state/refresh":
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
            elif path == "/api/admin/schedule":
                self._json(console.save_schedule(payload))
            elif path in {"/api/backup", "/api/policy", "/api/restore", "/api/bundle-backup", "/api/bundle-restore",
                          "/api/purge"}:
                self._json(console.submit(path.rsplit("/", 1)[1], payload), 202)
            else:
                self._json({"error": "Unknown operation"}, 404)
        except (BackupError, AzureError, OSError, ValueError) as exc:
            message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
            self._json({"error": message, "code": type(exc).__name__}, 400)


def read_build(path: Path) -> str:
    """Git SHA of the deployed revision, written by the packager; empty when absent or malformed."""
    try:
        value = object_value(json.loads(path.read_text(encoding="utf-8")), "build marker").get("commit")
    except (OSError, ValueError, BackupError):
        return ""
    return value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{7,40}", value) else ""


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Local-only armbackup UI design preview; no Azure")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--live-config", type=Path,
                        help="Explicit isolated Azure lab console; uses server-side credentials")
    parser.add_argument("--hosted", action="store_true",
                        help="App Service only; sign-in via ARMBACKUP_AUTH_MODE (entra EasyAuth or password)")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be in 1..65535")
    console: LiveConsole | None = None
    scheduler: SnapshotScheduler | None = None
    backups: BackupScheduler | None = None
    try:
        if args.live_config:
            settings = ConsoleConfig.load(args.live_config)
            if args.hosted and (not os.environ.get("WEBSITE_SITE_NAME")
                                or not os.environ.get("WEBSITE_HOSTNAME") or settings.archive_mode != "blob"):
                raise BackupError("Hosted mode requires App Service and explicit Blob archive")
            auth = load_auth(os.environ) if args.hosted else None
            console = LiveConsole.connect(settings, snapshot_only=args.hosted)
            live_server = ConsoleServer(
                ("0.0.0.0" if args.hosted else "127.0.0.1", args.port), console,
                hosted_host=os.environ.get("WEBSITE_HOSTNAME", "") if args.hosted else "",
                operator_id=auth.operator_id if auth else "",
                tenant_id=auth.tenant_id if auth else "",
                password_auth=auth.password if auth else None,
            )
            server: ThreadingHTTPServer = live_server
            live_server.build = read_build(args.live_config.parent / "build.json")
            if args.hosted:
                scheduler = SnapshotScheduler(console)
                backups = BackupScheduler(console)
                live_server.collector = scheduler
                console.on_state_change = scheduler.wake
            else:
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
    if scheduler is not None:
        scheduler.start()
    if backups is not None:
        backups.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if backups is not None:
            backups.close()
        if scheduler is not None:
            scheduler.close()
        if console:
            console.close()


if __name__ == "__main__":
    main()
