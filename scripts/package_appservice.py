from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def package(output: Path, config: dict, root: Path, *, job_dependencies: Path | None = None) -> None:
    if output.exists():
        raise ValueError("Refusing to overwrite an existing deploy package")
    console, capture = config["console"], config["capture"]
    if (console["archive_mode"] != "blob" or capture["credential"] != "managed_identity"
            or capture["storage"]["require_private_endpoint"] is not True):
        raise ValueError("App Service requires explicit managed identity and private Blob archive")
    console = {**console, "capture_config": "capture.json"}
    console.pop("local_archive", None)
    job = "App_Data/jobs/triggered/armbackup-snapshot"
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "x", ZIP_DEFLATED) as archive:
        for name in ("requirements.txt", "pyproject.toml"):
            archive.write(root / name, name)
        for path in (root / "src" / "armbackup").rglob("*"):
            if path.is_file() and "__pycache__" not in path.parts:
                archive.write(path, path.relative_to(root).as_posix())
                archive.write(path, f"{job}/armbackup/{path.relative_to(root / 'src' / 'armbackup').as_posix()}")
        archive.writestr("hosted/console.json", json.dumps(console))
        archive.writestr("hosted/capture.json", json.dumps(capture))
        archive.writestr(f"{job}/console.json", json.dumps(console))
        archive.writestr(f"{job}/capture.json", json.dumps(capture))
        archive.writestr(f"{job}/settings.job", (root / "webjob" / "snapshot-settings.job").read_bytes())
        entry = ZipInfo(f"{job}/run.sh")
        entry.create_system = 3
        entry.external_attr = 0o100755 << 16
        archive.writestr(entry, (root / "webjob" / "snapshot-run.sh").read_bytes().replace(b"\r\n", b"\n"))
        if job_dependencies is not None:
            for path in job_dependencies.rglob("*"):
                if path.is_file() and "__pycache__" not in path.parts and "bin" not in path.relative_to(job_dependencies).parts:
                    if path.suffix.lower() in {".exe", ".dll", ".pyd"}:
                        raise ValueError(f"Unexpected Windows binary in Linux WebJob: {path.name}")
                    archive.write(path, f"{job}/.python_packages/lib/site-packages/{path.relative_to(job_dependencies).as_posix()}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Package only application sources and explicit non-secret hosted config")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--job-dependencies", type=Path, required=True,
                        help="Linux Python 3.12 site-packages for the self-contained snapshot WebJob")
    args = parser.parse_args()
    value = os.environ.get("ARMBACKUP_DEPLOY_CONFIG")
    if not value:
        raise ValueError("ARMBACKUP_DEPLOY_CONFIG repository variable is required")
    if not args.job_dependencies.is_dir() or not (args.job_dependencies / "azure" / "identity").is_dir():
        raise ValueError("Snapshot WebJob requires packaged Linux runtime dependencies")
    package(args.output.resolve(), json.loads(value), Path(__file__).resolve().parents[1],
            job_dependencies=args.job_dependencies)


if __name__ == "__main__":
    main()
