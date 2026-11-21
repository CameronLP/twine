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
#
# Appearance (Follow System / Light / Dark) can be changed in two places: the
# Appearance submenu of the window's right-click menu (via the native messaging
# helper twine-settings-host) or the app icon's right-click menu
# ("twine --twine-appearance=…", which just saves the choice). Dark uses
# Chromium's auto dark mode, which recolours LINE's always-light page at render
# time; LINE's files are not changed. The bootstrap worker switches it live
# through chrome.debugger (see twine-bg.js), and twine-settings-host tells it
# about setting and GNOME style changes, so nothing needs a restart.

EXT_ID=ophjlpahpchlmihnnnihgmmeilfjmjjc
EXT_DIR=/app/share/line-extension
PROFILE="${XDG_CONFIG_HOME}/chromium"
APPEARANCE_FILE="${XDG_CONFIG_HOME}/twine/appearance"
NATIVE_HOST=io.github.twinechat.twine

# Shared with the host, so GNOME can read the images in Chromium's notifications.
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
# Chromium tags notifications with this desktop entry, so GNOME shows them
# under Twine's name and icon instead of Chromium's.
export CHROME_DESKTOP="${FLATPAK_ID}.desktop"

# True if a Twine Chromium is already running. A leftover SingletonLock
# after a crash doesn't count; only a live singleton socket does.
is_running() {
    python3 -I -c 'import socket, sys
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])' "${PROFILE}/SingletonSocket" 2>/dev/null
}

chromium() {
    zypak-wrapper.sh /app/chromium/chrome \
        --user-data-dir="${PROFILE}" \
        --class="${FLATPAK_ID}" \
        --load-extension="${EXT_DIR}" \
        --disable-extensions-except="${EXT_DIR}" \
        --no-first-run \
        --no-default-browser-check \
        --disable-component-update \
        --password-store=basic \
        --ozone-platform=x11 \
        --silent-debugger-extension-api \
        "$@"
}

# Let the extension reach twine-settings-host. Chromium looks for native
# messaging hosts in <user-data-dir>/NativeMessagingHosts.
write_native_host_manifest() {
    mkdir -p "${PROFILE}/NativeMessagingHosts"
    cat > "${PROFILE}/NativeMessagingHosts/${NATIVE_HOST}.json" <<EOF
{
  "name": "${NATIVE_HOST}",
  "description": "Twine settings helper",
  "path": "/app/libexec/twine-settings-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXT_ID}/"]
}
EOF
}

# Started by D-Bus activation (io.github.twinechat.Twine.service): GNOME wants
# to talk to Twine, for example because a notification was clicked after
# Twine quit. Start Twine as usual; once running, twine-settings-host owns the
# bus name and answers GNOME's request.
if [ "$1" = "--gapplication-service" ]; then
    shift
fi

# Started at login ("Start at Login", set up through the Background portal by
# twine-settings-host). Start with the window hidden; the helper passes this
# on to the bootstrap worker. If Twine is already running, there's nothing to
# do.
if [ "$1" = "--twine-autostart" ]; then
    shift
    is_running && exit 0
    export TWINE_START_HIDDEN=1
fi

# Handle "--twine-appearance=…" (from the desktop actions).
case "$1" in
--twine-appearance=*)
    choice="${1#--twine-appearance=}"
    shift
    case "${choice}" in
    system|light|dark) ;;
    *) echo "twine: appearance must be system, light or dark" >&2; exit 2 ;;
    esac
    mkdir -p "$(dirname "${APPEARANCE_FILE}")"
    echo "${choice}" > "${APPEARANCE_FILE}"
    # A running Twine picks up the change live; otherwise start it below.
    is_running && exit 0
    ;;
esac

if is_running; then
    # Already running: hand off to the existing instance.
    chromium --app="chrome-extension://${EXT_ID}/twine-activate.html" "$@"
    exit
fi

python3 /app/libexec/twine-prefs.py "${PROFILE}"
write_native_host_manifest
chromium --app=file:///app/share/twine/splash.html "$@"
