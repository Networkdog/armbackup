from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def package(output: Path, config: dict, root: Path, *, build: str = "") -> None:
    if output.exists():
        raise ValueError("Refusing to overwrite an existing deploy package")
    console, capture = config["console"], config["capture"]
    if (console["archive_mode"] != "blob" or capture["credential"] != "managed_identity"
            or capture["storage"]["require_private_endpoint"] is not True):
        raise ValueError("App Service requires explicit managed identity and private Blob archive")
    if build and not re.fullmatch(r"[0-9a-f]{7,40}", build):
        raise ValueError("Build commit must be a lowercase hexadecimal Git SHA")
    console = {**console, "capture_config": "capture.json"}
    console.pop("local_archive", None)
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "x", ZIP_DEFLATED) as archive:
        for name in ("requirements.txt", "pyproject.toml"):
            archive.write(root / name, name)
        for path in (root / "src" / "armbackup").rglob("*"):
            if path.is_file() and "__pycache__" not in path.parts:
                archive.write(path, path.relative_to(root).as_posix())
        archive.writestr("hosted/console.json", json.dumps(console))
        archive.writestr("hosted/capture.json", json.dumps(capture))
        if build:
            # Lets the deploy gate wait for this exact revision instead of probing the old container.
            archive.writestr("hosted/build.json", json.dumps({"commit": build}))


def main() -> None:
    parser = argparse.ArgumentParser(description="Package only application sources and explicit non-secret hosted config")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    value = os.environ.get("ARMBACKUP_DEPLOY_CONFIG")
    if not value:
        raise ValueError("ARMBACKUP_DEPLOY_CONFIG repository variable is required")
    package(args.output.resolve(), json.loads(value), Path(__file__).resolve().parents[1],
            build=os.environ.get("GITHUB_SHA", "").lower())


if __name__ == "__main__":
    main()
