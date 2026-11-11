#!/bin/sh
# macOS/Linux bootstrap. Local release folders work before the first npm publication.
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo "quota-router needs Node.js 24+ and npm. Install them from https://nodejs.org, then run this command again." >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "quota-router needs Node.js 24 or newer. Update Node.js, then run this command again." >&2
  exit 1
fi
case "$0" in
  */install.sh|install.sh)
    script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
    if [ -f "$script_dir/install.mjs" ]; then
      exec node "$script_dir/install.mjs" "$@"
    fi
    ;;
esac
if ! command -v npx >/dev/null 2>&1; then
  echo "quota-router needs npm (including npx). Install Node.js 24+ with npm from https://nodejs.org." >&2
  exit 1
fi
export npm_config_ignore_scripts=true
exec npx --yes opencode-quota-router@0.2.0 install "$@"
