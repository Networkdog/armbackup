"""Operator sign-in for the hosted console.

`ARMBACKUP_AUTH_MODE` selects who authenticates operators:
- `password` (default): one ID/password operator checked here, for tenants that cannot create an
  App Registration. The password is never stored; only a salted scrypt hash is read from an app setting.
- `entra`: App Service EasyAuth with Microsoft Entra ID; this process only checks the principal header
  the platform proxy forwards. Temporarily disabled (ENTRA_ENABLED) until an App Registration is available.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import hmac
import re
import secrets
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from armbackup.contracts import BackupError

MODES = ("entra", "password")
# Set to True once an App Registration exists; it re-enables the Entra (EasyAuth) sign-in path.
ENTRA_ENABLED = False
SESSION_COOKIE = "__Host-armbackup-session"
MIN_PASSWORD_LENGTH = 12
MAX_SESSIONS = 20
_SCRYPT = (2**15, 8, 3)  # OWASP scrypt profile: 32 MiB memory, p=3
_SCRYPT_MAX_N, _SCRYPT_MAX_R, _SCRYPT_MAX_P = 2**17, 16, 8
_ID = re.compile(r"[A-Za-z0-9._@-]{3,64}")
_UUID = re.compile(r"[a-f0-9-]{36}")


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
                          maxmem=256 * 1024 * 1024, dklen=32)


def hash_password(password: str) -> str:
    """`scrypt:N:r:p:salt:hash`. Colons only, so the value survives shells and app settings intact."""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise BackupError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    salt = secrets.token_bytes(16)
    n, r, p = _SCRYPT
    return ":".join(["scrypt", str(n), str(r), str(p), _b64(salt), _b64(_scrypt(password, salt, n, r, p))])


def parse_hash(value: str) -> tuple[int, int, int, bytes, bytes]:
    parts = value.split(":")
    try:
        if len(parts) != 6 or parts[0] != "scrypt":
            raise ValueError
        n, r, p = (int(part) for part in parts[1:4])
        salt, digest = _unb64(parts[4]), _unb64(parts[5])
        if (n < 2**14 or n & (n - 1) or n > _SCRYPT_MAX_N or not 1 <= r <= _SCRYPT_MAX_R
                or not 1 <= p <= _SCRYPT_MAX_P or len(salt) < 16 or len(digest) < 32):
            raise ValueError
    except ValueError:
        raise BackupError("ARMBACKUP_AUTH_PASSWORD_HASH must come from `python -m armbackup.auth hash-password`") from None
    return n, r, p, salt, digest


class LoginBlocked(Exception):
    def __init__(self, retry_after: int) -> None:
        super().__init__("Too many failed sign-in attempts")
        self.retry_after = retry_after


@dataclass
class _Failures:
    count: int = 0
    first: float = 0.0
    blocked_until: float = 0.0


class PasswordAuthenticator:
    """Single-operator ID/password check with server-side sessions.

    Sessions live in memory, so a restart or setting change signs everyone out and logout is real
    revocation. The hosted console already runs as one instance (its collector is in-process).
    """

    def __init__(
        self, username: str, password_hash: str, *, idle_seconds: int = 1800,
        absolute_seconds: int = 28800, max_failures: int = 5, lockout_seconds: int = 900,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not _ID.fullmatch(username):
            raise BackupError("ARMBACKUP_AUTH_USERNAME must be 3-64 letters, digits or . _ @ -")
        self.username = username
        self._hash = parse_hash(password_hash)
        self._idle, self._absolute = idle_seconds, absolute_seconds
        self._max_failures, self._lockout, self._clock = max_failures, lockout_seconds, clock
        self._failures: dict[str, _Failures] = {}
        self._sessions: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()
        # scrypt is memory-hard; one verification at a time bounds memory under a request burst.
        self._verify_lock = threading.Lock()

    def _blocked(self, now: float, keys: tuple[str, ...]) -> int:
        remaining = max((self._failures[key].blocked_until - now for key in keys if key in self._failures),
                        default=0.0)
        return int(remaining) + 1 if remaining > 0 else 0

    def _record_failure(self, now: float, key: str, limit: int) -> None:
        entry = self._failures.setdefault(key, _Failures(first=now))
        if now - entry.first > self._lockout:
            entry.count, entry.first = 0, now
        entry.count += 1
        if entry.count >= limit:
            entry.blocked_until = now + self._lockout
            entry.count, entry.first = 0, now

    def login(self, username: str, password: str, client: str) -> str | None:
        """Returns a new session token, or None for wrong credentials. Raises LoginBlocked when throttled."""
        # Per-client limit stops a single source; the global limit caps total guesses against the one account.
        keys = (f"ip:{client}", "global")
        n, r, p, salt, digest = self._hash
        with self._verify_lock:
            # Checked under the verify lock so a parallel burst cannot all pass before the first failure counts.
            with self._lock:
                retry = self._blocked(self._clock(), keys)
            if retry:
                raise LoginBlocked(retry)
            password_ok = hmac.compare_digest(_scrypt(password, salt, n, r, p), digest)
            user_ok = hmac.compare_digest(hashlib.sha256(username.encode()).digest(),
                                          hashlib.sha256(self.username.encode()).digest())
            now = self._clock()
            with self._lock:
                if not (password_ok and user_ok):
                    self._record_failure(now, keys[0], self._max_failures)
                    self._record_failure(now, keys[1], self._max_failures * 10)
                    return None
                self._failures.pop(keys[0], None)
                self._expire(now)
                while len(self._sessions) >= MAX_SESSIONS:
                    self._sessions.pop(min(self._sessions, key=lambda key: self._sessions[key][1]))
                token = secrets.token_urlsafe(32)
                self._sessions[hashlib.sha256(token.encode()).hexdigest()] = (now, now)
                return token

    def _expire(self, now: float) -> None:
        for key, (created, seen) in list(self._sessions.items()):
            if now - created > self._absolute or now - seen > self._idle:
                del self._sessions[key]

    def validate(self, token: str) -> bool:
        key = hashlib.sha256(token.encode()).hexdigest()
        now = self._clock()
        with self._lock:
            self._expire(now)
            session = self._sessions.get(key)
            if session is None:
                return False
            self._sessions[key] = (session[0], now)
            return True

    def logout(self, token: str) -> None:
        with self._lock:
            self._sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None)


@dataclass(frozen=True)
class AuthConfig:
    mode: str
    operator_id: str = ""
    tenant_id: str = ""
    password: PasswordAuthenticator | None = None


def _bounded(environ: Mapping[str, str], name: str, default: int, low: int, high: int) -> int:
    raw = environ.get(name, "").strip()
    if not raw:
        return default
    if not raw.isdecimal() or not low <= int(raw) <= high:
        raise BackupError(f"{name} must be an integer from {low} to {high}")
    return int(raw)


def load_auth(environ: Mapping[str, str]) -> AuthConfig:
    """Reads the sign-in mode from App Service settings; any missing or invalid value stops startup."""
    mode = environ.get("ARMBACKUP_AUTH_MODE", "").strip().lower() or "password"
    if mode not in MODES:
        raise BackupError(f"ARMBACKUP_AUTH_MODE must be one of {', '.join(MODES)}")
    if mode == "entra":
        if not ENTRA_ENABLED:
            raise BackupError("Entra sign-in is temporarily disabled; use ARMBACKUP_AUTH_MODE=password")
        operator, tenant = environ.get("ARMBACKUP_OPERATOR_ID", ""), environ.get("ARMBACKUP_TENANT_ID", "")
        if not all(_UUID.fullmatch(value) for value in (operator, tenant)):
            raise BackupError("Entra mode requires ARMBACKUP_OPERATOR_ID and ARMBACKUP_TENANT_ID")
        return AuthConfig("entra", operator, tenant)
    username, password_hash = environ.get("ARMBACKUP_AUTH_USERNAME", ""), environ.get("ARMBACKUP_AUTH_PASSWORD_HASH", "")
    if not username or not password_hash:
        raise BackupError("Password mode requires ARMBACKUP_AUTH_USERNAME and ARMBACKUP_AUTH_PASSWORD_HASH")
    return AuthConfig("password", password=PasswordAuthenticator(
        username, password_hash,
        idle_seconds=_bounded(environ, "ARMBACKUP_AUTH_IDLE_MINUTES", 30, 5, 480) * 60,
        absolute_seconds=_bounded(environ, "ARMBACKUP_AUTH_SESSION_HOURS", 8, 1, 24) * 3600,
        max_failures=_bounded(environ, "ARMBACKUP_AUTH_MAX_FAILURES", 5, 3, 20),
        lockout_seconds=_bounded(environ, "ARMBACKUP_AUTH_LOCKOUT_MINUTES", 15, 1, 240) * 60,
    ))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Create the value for ARMBACKUP_AUTH_PASSWORD_HASH")
    parser.add_argument("command", choices=["hash-password"])
    parser.add_argument("--generate", action="store_true", help="Create a random password and print it once")
    args = parser.parse_args(argv)
    if args.generate:
        password = secrets.token_urlsafe(24)
        print(f"Password (shown once, store it in your password manager): {password}")
    else:
        password = getpass.getpass("Password: ")
        if password != getpass.getpass("Repeat password: "):
            parser.exit(1, "Passwords do not match\n")
    try:
        print(f"ARMBACKUP_AUTH_PASSWORD_HASH={hash_password(password)}")
    except BackupError as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
