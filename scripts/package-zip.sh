#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-maximus-engenharia-inteligente-pwa-$(date +%Y%m%d-%H%M%S).zip}"
OUTPUT="$ROOT/$NAME"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

mkdir -p "$TEMP/maximus-engenharia-inteligente-pwa"
rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '*.zip' \
  "$ROOT/" "$TEMP/maximus-engenharia-inteligente-pwa/"

rm -f "$OUTPUT"
if command -v zip >/dev/null 2>&1; then
  (cd "$TEMP" && zip -qr "$OUTPUT" maximus-engenharia-inteligente-pwa)
else
  python - "$TEMP" "$OUTPUT" <<'PY'
from pathlib import Path
import sys
import zipfile
root = Path(sys.argv[1])
out = Path(sys.argv[2])
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in root.rglob('*'):
        if path.is_file():
            archive.write(path, path.relative_to(root))
PY
fi

printf 'ZIP criado: %s\n' "$OUTPUT"
