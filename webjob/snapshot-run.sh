#!/bin/sh
set -eu
JOB_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PYTHONPATH="$JOB_DIR:$JOB_DIR/.python_packages/lib/site-packages${PYTHONPATH:+:$PYTHONPATH}"
exec python -m armbackup.collector --console-config "$JOB_DIR/console.json"
