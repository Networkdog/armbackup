from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from armbackup.config import Config

ROOT = Path(__file__).resolve().parents[1]


def build(
    output: Path, *, python_version: str = "3.12", dependencies: bool = True,
    config_path: Path | None = None,
) -> None:
    if not re.fullmatch(r"3\.(11|12|13|14)", python_version):
        raise ValueError("Python runtime must be 3.11..3.14")
    if output.exists():
        raise FileExistsError("Refusing to overwrite an existing deployment package")
    if config_path is not None:
        config = Config.load(config_path)
        if config.credential != "managed_identity" or not config.require_private_storage:
            raise ValueError("Deployment requires managed_identity and private storage enforcement")
    with tempfile.TemporaryDirectory(prefix="armbackup-package-") as directory:
        stage = Path(directory)
        job = stage / "App_Data" / "jobs" / "triggered" / "armbackup"
        job.mkdir(parents=True)
        shutil.copytree(
            ROOT / "src" / "armbackup", job / "armbackup",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        for name in ("run.sh", "settings.job"):
            shutil.copyfile(ROOT / "webjob" / name, job / name)
        (job / "run.sh").write_bytes((job / "run.sh").read_bytes().replace(b"\r\n", b"\n"))
        shutil.copyfile(ROOT / "webjob" / "site_health.py", stage / "site_health.py")
        shutil.copyfile(ROOT / "examples" / "config.example.json", stage / "config.example.json")
        if config_path is not None:
            shutil.copyfile(config_path, stage / "config.json")
        shutil.copyfile(ROOT / "requirements.txt", stage / "requirements.lock.txt")
        shutil.copyfile(ROOT / "requirements.txt", stage / "requirements.txt")
        if dependencies:
            # Cross-target Linux wheels: never put Windows native binaries into a Linux WebJob.
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "--no-compile", "--only-binary=:all:",
                 "--platform", "manylinux2014_x86_64", "--implementation", "cp",
                 "--python-version", python_version, "--requirement", str(ROOT / "requirements.txt"),
                 "--target", str(job / ".python_packages" / "lib" / "site-packages")],
                check=True,
            )
        (stage / "package-info.json").write_text(json.dumps({
            "target": "Linux x86_64", "pythonVersion": python_version,
            "runtimeDependenciesIncluded": dependencies,
        }), encoding="utf-8")
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    # Windows pip generates host console launchers even when targeting Linux wheels.
                    if (job / ".python_packages" / "lib" / "site-packages" / "bin") in path.parents:
                        continue
                    if path.suffix.lower() in {".exe", ".dll", ".pyd"}:
                        raise ValueError(f"Unexpected Windows binary in Linux package: {path.name}")
                    name = path.relative_to(stage).as_posix()
                    info = zipfile.ZipInfo(name)
                    info.create_system = 3
                    info.external_attr = (0o100755 if path.name == "run.sh" else 0o100644) << 16
                    archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a Linux App Service site ZIP with WebJob")
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "armbackup-webjob.zip")
    parser.add_argument("--python-version", default="3.12")
    parser.add_argument("--config", type=Path,
                        help="Explicitly include validated non-secret production configuration")
    parser.add_argument("--without-dependencies", action="store_true",
                        help="Test/source artifact only; not a runnable offline deployment")
    args = parser.parse_args()
    build(args.output, python_version=args.python_version,
          dependencies=not args.without_dependencies, config_path=args.config)
    print(args.output)


if __name__ == "__main__":
    main()
