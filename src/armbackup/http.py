from __future__ import annotations

import re
import threading
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

import requests
from azure.core.credentials import TokenCredential

from armbackup.contracts import ArmHttpError, BackupError, JsonObject, object_value

ARM_ORIGIN = "https://management.azure.com"
ARM_SCOPE = ARM_ORIGIN + "/.default"


def arm_url(path: str, api_version: str | None) -> str:
    url = urlsplit(urljoin(ARM_ORIGIN + "/", path))
    decoded_path = unquote(url.path)
    if (url.scheme != "https" or url.netloc.lower() != "management.azure.com"
            or url.fragment or not decoded_path.startswith("/")
            or "\\" in decoded_path
            or any(p in {".", ".."} for p in decoded_path.split("/"))):
        raise BackupError("Refusing untrusted ARM URL")
    if "api-version" not in parse_qs(url.query):
        if api_version is None:
            raise BackupError("Missing API version")
        return url.geturl() + ("&" if url.query else "?") + "api-version=" + api_version
    return url.geturl()


def error_code(response: requests.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return "InvalidErrorResponse"
    code = data.get("error", {}).get("code", "ArmError") if isinstance(data, dict) else "ArmError"
    return code if isinstance(code, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", code) else "ArmError"


def retry_delay(value: str | None, attempt: int) -> float:
    if value:
        try:
            return min(60.0, max(0.0, float(value)))
        except ValueError:
            try:
                moment = parsedate_to_datetime(value)
                return min(60.0, max(0.0, (moment - datetime.now(UTC)).total_seconds()))
            except (ValueError, TypeError):
                pass
    return min(30.0, float(2 ** attempt))


class ArmClient:
    def __init__(
        self, credential: TokenCredential, *, retries: int = 4, timeout: int = 60,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.credential = credential
        self.retries = retries
        self.timeout = timeout
        self.sleep = sleep
        self.local = threading.local()

    def _session(self) -> requests.Session:
        session: requests.Session | None = getattr(self.local, "session", None)
        if session is None:
            session = requests.Session()
            self.local.session = session
        return session

    def request(
        self, method: str, path: str, api_version: str | None = None,
        body: JsonObject | None = None,
    ) -> JsonObject:
        url = arm_url(path, api_version)
        if method not in {"GET", "POST", "PUT"}:
            raise BackupError("Unsupported ARM method")
        for attempt in range(self.retries + 1):
            token = self.credential.get_token(ARM_SCOPE).token
            try:
                response = self._session().request(
                    method, url, headers={"Authorization": f"Bearer {token}"},
                    json=body, timeout=(10, self.timeout), allow_redirects=False,
                )
            except (requests.Timeout, requests.ConnectionError) as exc:
                if attempt == self.retries:
                    raise BackupError(f"ARM transport exhausted: {type(exc).__name__}") from exc
                self.sleep(retry_delay(None, attempt))
                continue
            if response.status_code in {408, 429, 500, 502, 503, 504} and attempt < self.retries:
                self.sleep(retry_delay(response.headers.get("Retry-After"), attempt))
                continue
            if not 200 <= response.status_code < 300:
                raise ArmHttpError(response.status_code, error_code(response))
            if not response.content:
                return {}
            try:
                return object_value(response.json(), "ARM response")
            except ValueError as exc:
                raise BackupError("ARM returned invalid JSON") from exc
        raise BackupError("ARM retry loop exhausted")

    def pages(self, path: str, api_version: str) -> Iterator[JsonObject]:
        seen: set[str] = set()
        next_path: str | None = path
        for _ in range(10000):
            if next_path is None:
                return
            normalized = arm_url(next_path, api_version)
            if normalized in seen:
                raise BackupError("Repeated ARM nextLink")
            seen.add(normalized)
            data = self.request("GET", normalized)
            values = data.get("value")
            if not isinstance(values, list):
                raise BackupError("ARM list response missing value array")
            for value in values:
                yield object_value(value, "ARM list item")
            link = data.get("nextLink")
            if link is not None and (not isinstance(link, str) or not link):
                raise BackupError("Invalid ARM nextLink")
            next_path = link
        raise BackupError("ARM pagination limit exceeded")
