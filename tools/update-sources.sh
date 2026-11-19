#!/bin/sh
# Re-pin the LINE extension and Chromium sources in the Flatpak manifest.
#
#   tools/update-sources.sh            # update both
#   tools/update-sources.sh extension  # only the LINE extension
#   tools/update-sources.sh chromium   # only Chromium
#
# Chromium is pinned to the snapshot build closest to (at or below) the
# current Stable channel's base revision.
set -eu

cd "$(dirname "$0")/.."
MANIFEST=io.github.twinechat.Twine.yml
EXT_ID=ophjlpahpchlmihnnnihgmmeilfjmjjc
WHAT=${1:-all}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

replace_sha_after() {
    # Replace the sha256 on the line following the first line matching $1.
    python3 -I - "$MANIFEST" "$1" "$2" <<'EOF'
import re, sys
path, marker, sha = sys.argv[1:]
lines = open(path).read().split("\n")
for i, line in enumerate(lines):
    if marker in line:
        lines[i + 1] = re.sub(r"sha256: \w+", f"sha256: {sha}", lines[i + 1])
        break
else:
    sys.exit(f"marker not found: {marker}")
open(path, "w").write("\n".join(lines))
EOF
}

if [ "$WHAT" = all ] || [ "$WHAT" = chromium ]; then
    rev=$(curl -fsS https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json \
        | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["channels"]["Stable"]["revision"])')
    echo "Stable base revision: $rev"
    found=
    for r in $(seq "$rev" -1 $((rev - 200))); do
        url="https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/$r/chrome-linux.zip"
        if curl -fsSI -o /dev/null "$url"; then found=$r; break; fi
    done
    [ -n "$found" ] || { echo "no snapshot found near r$rev" >&2; exit 1; }
    echo "Using Chromium snapshot r$found"
    curl -fsSL -o "$TMP/chrome-linux.zip" "$url"
    sha=$(sha256sum "$TMP/chrome-linux.zip" | cut -d' ' -f1)
    sed -i -E "s#(chromium-browser-snapshots/Linux_x64/)[0-9]+(/chrome-linux.zip)#\1$found\2#" "$MANIFEST"
    replace_sha_after "chromium-browser-snapshots" "$sha"
fi

if [ "$WHAT" = all ] || [ "$WHAT" = extension ]; then
    url=$(grep -oE 'https://clients2.google.com/service/update2/crx[^ ]+' "$MANIFEST")
    curl -fsSL -o "$TMP/line.crx" "$url"
    python3 -I tools/crx_unpack.py "$TMP/line.crx" "$TMP/ext" "$EXT_ID"
    sha=$(sha256sum "$TMP/line.crx" | cut -d' ' -f1)
    replace_sha_after "clients2.google.com" "$sha"
fi

echo "Updated $MANIFEST:"
git --no-pager diff --stat -- "$MANIFEST" 2>/dev/null || true
