#!/usr/bin/env bash
# Cross-platform Bash builder for the Configuration Vault (armbackup) Azure App Service ZIP package.
# Usage:
#   ./infra/appservice/build-package.sh [--output path.zip] [--python-version 3.14] [--oryx-build] [--include-deploy-kit]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON_VERSION="${PYTHON_VERSION:-3.12}"
PYTHON_BIN="${PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi
OUT="$ROOT/artifacts/appservice/armbackup.zip"
ORYX_BUILD=0
INCLUDE_KIT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --output|-o)
      OUT="$2"
      shift 2
      ;;
    --python-version)
      PYTHON_VERSION="$2"
      shift 2
      ;;
    --oryx-build)
      ORYX_BUILD=1
      shift
      ;;
    --include-deploy-kit)
      INCLUDE_KIT=1
      shift
      ;;
    *)
      OUT="$1"
      shift
      ;;
  esac
done

STAGE="$ROOT/artifacts/appservice/stage"

echo "[1/4] Staging application files..."
rm -rf "$STAGE"
mkdir -p "$STAGE/src"
cp "$ROOT/pyproject.toml" "$ROOT/README.md" "$STAGE/"
cp -R "$ROOT/src/armbackup" "$STAGE/src/armbackup"
find "$STAGE/src/armbackup" \( -name "__pycache__" -o -name "*.egg-info" -o -name "*.pyc" -o -name "build-info.json" \) -exec rm -rf {} +
tr -d '\r' < "$HERE/startup.sh" > "$STAGE/startup.sh"
chmod 755 "$STAGE/startup.sh"

for SEED_CAND in "$HERE/storage_seed" "$ROOT/storage_seed"; do
  if [ -d "$SEED_CAND" ]; then
    cp -R "$SEED_CAND" "$STAGE/storage_seed"
    echo "    Bundled startup Storage seed directory: $SEED_CAND"
    break
  fi
done

"$PYTHON_BIN" - "$ROOT" "$STAGE" <<'PY'
import datetime, json, os, pathlib, subprocess, sys, tomllib
root = pathlib.Path(sys.argv[1])
stage = pathlib.Path(sys.argv[2])
ver = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
sha = os.environ.get("GITHUB_SHA", "").strip().lower()
if not sha:
    try:
        sha = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip().lower()
    except Exception:
        sha = ""
run_no = os.environ.get("GITHUB_RUN_NUMBER", "").strip()
info = {
    "version": ver,
    "commit": sha if len(sha) >= 7 else "",
    "git_sha": sha[:12] if len(sha) >= 7 else "",
    "built_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "run_number": run_no if run_no.isdigit() else "",
}
(stage / "src" / "armbackup" / "build-info.json").write_text(json.dumps(info) + "\n", encoding="utf-8")
PY

if [ "$ORYX_BUILD" -eq 0 ]; then
  echo "[2/4] Bundling Linux manylinux wheels for Python $PYTHON_VERSION..."
  "$PYTHON_BIN" -m pip install --disable-pip-version-check --no-compile --quiet \
    --target "$STAGE/.python_packages/lib/site-packages" \
    --platform manylinux2014_x86_64 \
    --platform manylinux_2_28_x86_64 \
    --implementation cp \
    --python-version "$PYTHON_VERSION" \
    --only-binary=:all: \
    -r "$ROOT/requirements.txt"
else
  echo "[2/4] Oryx remote build selected (--oryx-build): copying requirements.txt..."
  cp "$ROOT/requirements.txt" "$STAGE/requirements.txt"
fi

echo "[3/4] Writing ZIP archive..."
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
"$PYTHON_BIN" - "$STAGE" "$OUT" <<'PY'
import pathlib, sys, time, zipfile
stage = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
now_utc = time.gmtime()[:6]
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for item in sorted(stage.rglob("*")):
        if item.is_file():
            arcname = item.relative_to(stage).as_posix()
            info = zipfile.ZipInfo(arcname, date_time=now_utc)
            info.external_attr = (0o755 if arcname == "startup.sh" else 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, item.read_bytes())
PY

echo "[4/4] Cleaning staging directory..."
rm -rf "$STAGE"
if [ "$INCLUDE_KIT" -eq 1 ]; then
  if command -v az >/dev/null 2>&1; then
    echo "[4b/4] Pre-compiling main.bicep -> azuredeploy.json for offline customer deployment..."
    az bicep build --file "$HERE/main.bicep" --outfile "$HERE/azuredeploy.json" >/dev/null 2>&1 || true
  fi
  if [ ! -f "$HERE/azuredeploy.json" ]; then
    echo "[ERROR] azuredeploy.json is missing and could not be compiled." >&2
    exit 1
  fi
fi

"$PYTHON_BIN" - "$OUT" "$INCLUDE_KIT" "$HERE" <<'PY'
import hashlib, pathlib, shutil, sys, time, zipfile

out = pathlib.Path(sys.argv[1])
include_kit = sys.argv[2] == "1"
here = pathlib.Path(sys.argv[3])

digest = hashlib.sha256(out.read_bytes()).hexdigest()
(out.parent / f"{out.name}.sha256").write_text(f"{digest}  {out.name}\n", encoding="utf-8")
print(f"Package ready: {out} (sha256={digest[:12]}...)")

if include_kit:
    kit_stage = out.parent / "customer-kit-stage"
    if kit_stage.exists():
        shutil.rmtree(kit_stage)
    kit_stage.mkdir(parents=True)
    shutil.copy2(out, kit_stage / "armbackup.zip")
    (kit_stage / "armbackup.zip.sha256").write_text(f"{digest}  armbackup.zip\n", encoding="utf-8")
    for name in (
        "Deploy-AppService.ps1",
        "deploy-appservice.sh",
        "deploy.config.example.json",
        "azuredeploy.json",
        "main.bicep",
        "main.bicepparam",
        "private-network.bicep",
        "shared-private-endpoints.bicep",
        "storage-setup.bicep",
        "keyvault-setup.bicep",
        "CUSTOMER_DEPLOY_KO.md",
    ):
        src = here / name
        dst = kit_stage / name
        if name.endswith(".sh"):
            dst.write_bytes(src.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n"))
        else:
            shutil.copy2(src, dst)
    kit_zip = out.parent / "armbackup-customer-kit.zip"
    if kit_zip.exists():
        kit_zip.unlink()
    now_utc = time.gmtime()[:6]
    with zipfile.ZipFile(kit_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for item in sorted(kit_stage.rglob("*")):
            if item.is_file():
                arcname = item.relative_to(kit_stage).as_posix()
                info = zipfile.ZipInfo(arcname, date_time=now_utc)
                info.external_attr = (0o755 if arcname.endswith(".sh") else 0o644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, item.read_bytes())
    shutil.rmtree(kit_stage)
    print(f"Customer deployment kit ready: {kit_zip}")
PY
