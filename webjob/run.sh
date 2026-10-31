#!/bin/sh
set -eu
JOB_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PYTHONPATH="$JOB_DIR:$JOB_DIR/.python_packages/lib/site-packages${PYTHONPATH:+:$PYTHONPATH}"
: "${ARMBACKUP_CONFIG:?Set ARMBACKUP_CONFIG to an absolute, deployed config.json path}"
exec python -m armbackup --config "$ARMBACKUP_CONFIG" backup
