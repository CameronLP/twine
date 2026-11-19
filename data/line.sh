#!/bin/sh
# Launch the LINE Chrome extension in its own Chromium app window.
#
# The extension is loaded unpacked from /app/share/line-extension with its
# Web Store key, so its ID (and chrome-extension:// origin) matches the
# official one. Chromium runs inside the Flatpak sandbox via zypak.

EXT_ID=ophjlpahpchlmihnnnihgmmeilfjmjjc
EXT_DIR=/app/share/line-extension

export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"

exec zypak-wrapper.sh /app/chromium/chrome \
    --user-data-dir="${XDG_CONFIG_HOME}/line-chromium" \
    --class="${FLATPAK_ID}" \
    --load-extension="${EXT_DIR}" \
    --disable-extensions-except="${EXT_DIR}" \
    --app="chrome-extension://${EXT_ID}/index.html" \
    --no-first-run \
    --no-default-browser-check \
    --disable-component-update \
    --password-store=basic \
    --ozone-platform-hint=auto \
    "$@"
