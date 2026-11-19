#!/usr/bin/python3
"""Set Twine's Chromium profile preferences before Chromium starts.

Turns on the GTK theme, so Chromium draws its title bar and window buttons
with the system GTK theme (Adwaita on GNOME) instead of its own style. It
also keeps Chromium's client-side frame, because GNOME's compositor has no
server-side decorations.

Usage: twine-prefs.py <user-data-dir>
"""
import json
import os
import sys

SETTINGS = {
    ("extensions", "theme", "system_theme"): 1,  # ui::SystemTheme::kGtk
    ("extensions", "theme", "use_system"): True,  # older Chromium versions
    ("browser", "custom_chrome_frame"): True,
}


def main():
    profile = os.path.join(sys.argv[1], "Default")
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
