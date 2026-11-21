#!/usr/bin/python3
"""Prepare Twine's Chromium profile before Chromium starts.

Turns on "use system title bar", so GNOME's window manager draws the native
Adwaita title bar and buttons around Twine's X11 window. It also turns on the
GTK theme, for the parts Chromium still draws itself. It keeps session cookies
across restarts, so LINE stays logged in, and sets the window size for the
first start.

It also clears Chromium's cached service workers whenever the installed Twine
build changes. Chromium only re-registers an extension's service worker when
the extension version changes, so without this an updated Twine would keep
running the previous build's bootstrap worker (LINE's version stays the same).
LINE's own data (extension storage, IndexedDB) is kept.

Usage: twine-prefs.py <user-data-dir>
"""
import configparser
import json
import os
import shutil
import sys

SETTINGS = {
    ("extensions", "theme", "system_theme"): 1,  # ui::SystemTheme::kGtk
    ("extensions", "theme", "use_system"): True,  # older Chromium versions
    ("browser", "custom_chrome_frame"): False,  # use the system title bar
    # "Continue where you left off". LINE's login session is the server's
    # "lct" cookie, which has no expiry, so Chromium would drop it on exit and
    # LINE would ask to log in again on every start. With this setting
    # Chromium keeps session cookies across restarts. It does not reopen old
    # windows, because the launcher always starts Chromium with --app.
    ("session", "restore_on_startup"): 1,
}

# Size of the Twine window on first start. Chromium saves the window's size
# for each --app URL under browser.app_window_placement and restores it later,
# so this default is only written when nothing is saved yet. The key is the
# app name for the splash URL, split at the "." like any Chromium pref path.
# 960x680 fits LINE's chat list and conversation side by side, and still fits
# on a 1366x768 screen under GNOME's top bar.
DEFAULT_PLACEMENT_KEYS = ("browser", "app_window_placement", "_/app/share/twine/splash", "html")
DEFAULT_PLACEMENT = {"left": 100, "top": 80, "right": 1060, "bottom": 760, "maximized": False}


def app_commit():
    info = configparser.ConfigParser()
    info.read("/.flatpak-info")
    return info.get("Instance", "app-commit", fallback="")


def reset_service_workers_on_update(profile):
    stamp_path = os.path.join(profile, "twine-build")
    build = app_commit()
    try:
        with open(stamp_path, encoding="utf-8") as f:
            previous = f.read().strip()
    except FileNotFoundError:
        previous = None
    if previous == build:
        return
    shutil.rmtree(os.path.join(profile, "Service Worker"), ignore_errors=True)
    os.makedirs(profile, exist_ok=True)
    with open(stamp_path, "w", encoding="utf-8") as f:
        f.write(build + "\n")


def main():
    profile = os.path.join(sys.argv[1], "Default")
    reset_service_workers_on_update(profile)
    path = os.path.join(profile, "Preferences")
    try:
        with open(path, encoding="utf-8") as f:
            prefs = json.load(f)
    except FileNotFoundError:
        prefs = {}
    except (OSError, ValueError) as e:
        print(f"twine-prefs: leaving {path} alone: {e}", file=sys.stderr)
        return

    changed = False
    for keys, value in SETTINGS.items():
        node = prefs
        for key in keys[:-1]:
            node = node.setdefault(key, {})
        if node.get(keys[-1]) != value:
            node[keys[-1]] = value
            changed = True

    node = prefs
    for key in DEFAULT_PLACEMENT_KEYS[:-1]:
        node = node.setdefault(key, {})
    if DEFAULT_PLACEMENT_KEYS[-1] not in node:
        node[DEFAULT_PLACEMENT_KEYS[-1]] = dict(DEFAULT_PLACEMENT)
        changed = True

    if changed:
        os.makedirs(profile, exist_ok=True)
        tmp = path + ".twine-tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(prefs, f)
        os.replace(tmp, path)


if __name__ == "__main__":
    main()
