"""Azure control-plane configuration backup."""

from __future__ import annotations

import os
import site
import sys
from pathlib import Path

__version__ = "0.1.0"


def ensure_appservice_site_packages(
    environ: dict[str, str] | None = None,
    version_info: tuple[int, int] | None = None,
) -> list[str]:
    """Keep Oryx's antenv site-packages importable even if Startup Command overwrote PYTHONPATH."""
    env = os.environ if environ is None else environ
    if environ is None and not any(
        env.get(key) for key in ("WEBSITE_SITE_NAME", "APP_PATH", "VIRTUALENVIRONMENT_PATH")
    ):
        return []
    major, minor = version_info if version_info is not None else (sys.version_info.major, sys.version_info.minor)
    rel = Path("lib") / f"python{major}.{minor}" / "site-packages"
    roots: list[Path] = []
    venv_env = env.get("VIRTUALENVIRONMENT_PATH", "").strip()
    if venv_env:
        roots.append(Path(venv_env))
    direct_site_packages: list[Path] = []
    for base in (env.get("APP_PATH", "").strip(), str(Path.cwd()), "/home/site/wwwroot"):
        if base:
            direct_site_packages.append(Path(base) / ".python_packages" / "lib" / "site-packages")
            roots.append(Path(base) / "antenv")
    roots.append(Path("/antenv"))
    added: list[str] = []
    seen = {str(Path(entry)) for entry in sys.path if entry}
    candidates = [*direct_site_packages, *(root / rel for root in roots)]
    for candidate in candidates:
        resolved = str(candidate)
        if resolved not in seen and candidate.is_dir():
            site.addsitedir(resolved)
            seen.add(resolved)
            added.append(resolved)
    return added


ensure_appservice_site_packages()


