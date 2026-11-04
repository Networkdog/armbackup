from __future__ import annotations

import os
import re
import sys
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO

from armbackup.contracts import BackupError, digest, require_view_artifact


def resolved_path(path: Path) -> Path:
    result = path.resolve()
    if sys.platform == "win32":
        name = str(result)
        # Concurrent directory creation can leave the Windows extended namespace prefix.
        if name.startswith("\\\\?\\UNC\\"):
            return Path("\\\\" + name[8:])
        if name.startswith("\\\\?\\") and len(name) > 6 and name[4].isalpha() and name[5:7] == ":\\":
            return Path(name[4:])
    return result


class LocalArchive:
    """Explicit local lab storage, not a fallback or a substitute for private Blob validation."""

    def __init__(self, root: Path) -> None:
        if root.is_symlink():
            raise BackupError("Local archive root must not be a symlink")
        self.root = resolved_path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._mutex = threading.Lock()
        self._locked = False

    def _path(self, name: str) -> Path:
        if (not name or name.startswith("/") or "\\" in name
                or any(part in {"", ".", ".."} for part in name.split("/"))):
            raise BackupError("Unsafe local archive path")
        path = self.root.joinpath(*name.split("/"))
        if any(parent.is_symlink() for parent in (path, *path.parents) if parent != self.root.parent):
            raise BackupError("Symlinks are not allowed in the local archive")
        if not resolved_path(path).is_relative_to(self.root):
            raise BackupError("Local archive path escapes its root")
        return path

    def put(self, name: str, content: bytes) -> None:
        path = self._path(name)
        temporary: Path | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".writing-", delete=False) as file:
                temporary = Path(file.name)
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            os.link(temporary, path)
        except OSError as exc:
            raise BackupError(f"Local archive write failed: {type(exc).__name__}") from exc
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def get(self, name: str) -> bytes:
        try:
            return self._path(name).read_bytes()
        except OSError as exc:
            raise BackupError(f"Local archive read failed: {type(exc).__name__}") from exc

    def read_pointer(self, name: str) -> tuple[bytes, str] | None:
        try:
            content = self._path(name).read_bytes()
            return content, digest(content)
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise BackupError(f"Local pointer read failed: {type(exc).__name__}") from exc

    def replace_pointer(self, name: str, content: bytes, etag: str | None) -> bool:
        self.assert_lock()
        if not re.fullmatch(r"console/views/(?:heads|status)/[a-f0-9]{64}\.json", name):
            raise BackupError("Only state view pointers may be replaced")
        current = self.read_pointer(name)
        if (current[1] if current else None) != etag:
            return False
        path, temporary = self._path(name), None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".writing-", delete=False) as file:
                temporary = Path(file.name)
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
            return True
        except OSError as exc:
            raise BackupError(f"Local pointer publication failed: {type(exc).__name__}") from exc
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def delete_view_artifact(self, name: str, etag: str) -> bool:
        self.assert_lock()
        require_view_artifact(name)
        current = self.read_pointer(name)
        if current is None:
            return True
        if current[1] != etag:
            return False
        try:
            self._path(name).unlink()
            return True
        except OSError as exc:
            raise BackupError(f"Local cache artifact deletion failed: {type(exc).__name__}") from exc

    def names(self, prefix: str, *, limit: int = 1000) -> list[str]:
        if not 1 <= limit <= 10000:
            raise BackupError("Local archive listing limit must be in 1..10000")
        self._path(prefix)
        try:
            result = []
            for path in self.root.rglob("*"):
                name = path.relative_to(self.root).as_posix()
                if path.is_file() and name.startswith(prefix):
                    self._path(name)
                    result.append(name)
                    if len(result) > limit:
                        raise BackupError("Local archive listing exceeds limit; narrow its prefix")
            return sorted(result)
        except OSError as exc:
            raise BackupError(f"Local archive listing failed: {type(exc).__name__}") from exc

    def assert_lock(self) -> None:
        if not self._locked:
            raise BackupError("Local capture lock is not held")

    @staticmethod
    def _file_lock(file: BinaryIO, *, release: bool = False) -> None:
        file.seek(0)
        if sys.platform == "win32":
            import msvcrt

            msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK if release else msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(file.fileno(), fcntl.LOCK_UN if release else fcntl.LOCK_EX | fcntl.LOCK_NB)

    @contextmanager
    def guard(self, key: str) -> Iterator[None]:
        if not self._mutex.acquire(blocking=False):
            raise BackupError("A local capture operation is already running")
        try:
            lock_path = self._path(f"locks/{key}.lock")
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            with lock_path.open("a+b") as file:
                if file.tell() == 0:
                    file.write(b"\0")
                    file.flush()
                try:
                    self._file_lock(file)
                except OSError as exc:
                    raise BackupError("Another process holds the local capture lock") from exc
                self._locked = True
                try:
                    yield
                    self.assert_lock()
                finally:
                    self._locked = False
                    self._file_lock(file, release=True)
        finally:
            self._mutex.release()
