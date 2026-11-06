#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
if [ ! -x bin/node ]; then
    echo "This updater requires the DataLite portable (bin/node)." >&2
    echo "Source installs: pull this custom repository and rebuild instead." >&2
    exit 1
fi
exec ./bin/node scripts/updater.cjs
