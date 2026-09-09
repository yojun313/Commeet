#!/usr/bin/env bash
# Chrome 웹 스토어에 올릴 확장 zip을 만듭니다: dist/commeet-povis-<version>.zip
#
# 스토어는 manifest.json이 zip의 최상위에 있어야 하므로 extension/ 폴더 "안"을
# 묶습니다. README와 macOS 잡동사니(.DS_Store)는 뺍니다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/extension"
VERSION="$(python3 -c "import json; print(json.load(open('$SRC/manifest.json'))['version'])")"
OUT="$ROOT/dist/commeet-povis-$VERSION.zip"

mkdir -p "$ROOT/dist"
rm -f "$OUT"
(cd "$SRC" && zip -qr "$OUT" . -x "README.md" -x ".DS_Store" -x "*/.DS_Store")

echo "$OUT"
unzip -Z1 "$OUT" | sed 's/^/  /'
