#!/usr/bin/python3
"""Prepare Twine's Chromium profile before Chromium starts.

Turns on the GTK theme, so Chromium draws its title bar and window buttons
with the system GTK theme (Adwaita on GNOME) instead of its own style. It
also keeps Chromium's client-side frame, because GNOME's compositor has no
server-side decorations.

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
    ("browser", "custom_chrome_frame"): True,
}


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

    if changed:
        os.makedirs(profile, exist_ok=True)
        tmp = path + ".twine-tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(prefs, f)
        os.replace(tmp, path)


if __name__ == "__main__":
    main()
