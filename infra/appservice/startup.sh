#!/bin/bash
# Azure App Service (Linux) single-process startup script for Configuration Vault (armbackup).
# Runs the HTTP/1.1 console server, in-process SnapshotScheduler, and daily BackupScheduler inside one Python process.
set -euo pipefail

if [ -n "${APP_ROOT:-}" ] && [ -d "${APP_ROOT}" ]; then
  cd "$APP_ROOT"
elif [ -n "${APP_PATH:-}" ] && [ -d "${APP_PATH}/src/armbackup" ]; then
  APP_ROOT="$APP_PATH"
  cd "$APP_ROOT"
else
  APP_ROOT="/home/site/wwwroot"
  cd "$APP_ROOT"
fi

if [ -n "${VIRTUAL_ENV:-}" ] && [ -x "${VIRTUAL_ENV}/bin/python" ]; then
  PYTHON_BIN="${VIRTUAL_ENV}/bin/python"
elif [ -x "$APP_ROOT/antenv/bin/python" ]; then
  # Oryx remote build virtual environment (SCM_DO_BUILD_DURING_DEPLOYMENT=true)
  # shellcheck disable=SC1091
  source "$APP_ROOT/antenv/bin/activate"
  PYTHON_BIN="$APP_ROOT/antenv/bin/python"
else
  PYTHON_BIN="python"
fi

EXTRA_PATHS=""
if [ -d "$APP_ROOT/.python_packages/lib/site-packages" ]; then
  EXTRA_PATHS="$APP_ROOT/.python_packages/lib/site-packages"
fi
if [ -d "$APP_ROOT/src" ]; then
  EXTRA_PATHS="${EXTRA_PATHS:+$EXTRA_PATHS:}$APP_ROOT/src"
fi
export PYTHONPATH="${EXTRA_PATHS}${PYTHONPATH:+:$PYTHONPATH}"

LISTEN_PORT="${PORT:-${WEBSITES_PORT:-8000}}"
if [ -f "$APP_ROOT/hosted/console.json" ]; then
  exec "$PYTHON_BIN" -m armbackup.webui --hosted --port "$LISTEN_PORT" --live-config "$APP_ROOT/hosted/console.json"
fi
exec "$PYTHON_BIN" -m armbackup.webui --hosted --port "$LISTEN_PORT"
