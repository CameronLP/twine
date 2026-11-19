#!/bin/sh
# Twine: launch the LINE Chrome extension in its own Chromium window.
#
# The extension is loaded unpacked from /app/share/line-extension with its
# Web Store key, so its ID (and chrome-extension:// origin) matches the
# official one. Chromium runs inside the Flatpak sandbox via zypak. It uses
# X11 (XWayland) with the system title bar, so GNOME's window manager draws a
# native Adwaita title bar. On Wayland, Chromium would have to draw its own.
#
# LINE's page is not opened with --app directly: that races extension loading
# and shows ERR_BLOCKED_BY_CLIENT. The launcher opens a local splash page, and
# Twine's bootstrap service worker (twine-bg.js) navigates that window to LINE
# once the extension is ready. If Twine is already running, the launcher opens
# twine-activate.html instead, which focuses the existing window.

EXT_ID=ophjlpahpchlmihnnnihgmmeilfjmjjc
EXT_DIR=/app/share/line-extension
PROFILE="${XDG_CONFIG_HOME}/chromium"

export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"

# True if a Twine Chromium is already running. A leftover SingletonLock
# after a crash doesn't count; only a live singleton socket does.
is_running() {
    python3 -I -c 'import socket, sys
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])' "${PROFILE}/SingletonSocket" 2>/dev/null
}

if is_running; then
    # Already running: hand off to the existing instance.
    start="--app=chrome-extension://${EXT_ID}/twine-activate.html"
else
    python3 /app/libexec/twine-prefs.py "${PROFILE}"
    start="--app=file:///app/share/twine/splash.html"
fi

exec zypak-wrapper.sh /app/chromium/chrome \
    --user-data-dir="${PROFILE}" \
    --class="${FLATPAK_ID}" \
    --load-extension="${EXT_DIR}" \
    --disable-extensions-except="${EXT_DIR}" \
    "${start}" \
    --no-first-run \
    --no-default-browser-check \
    --disable-component-update \
    --password-store=basic \
    --ozone-platform=x11 \
    "$@"
