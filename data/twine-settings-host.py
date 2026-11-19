#!/usr/bin/python3
"""Twine settings helper (Chromium native messaging host).

Twine's bootstrap service worker keeps a connection open to this program
(chrome.runtime.connectNative("io.github.twinechat.twine")). Messages use
Chromium's native messaging framing: a 4-byte native-endian length followed
by UTF-8 JSON.

To the worker, sent at start and whenever something changes:
    {"appearance": "system" | "light" | "dark", "systemDark": true | false}
  "appearance" is Twine's saved choice ($XDG_CONFIG_HOME/twine/appearance,
  which the dock-menu actions also write). "systemDark" is GNOME's light/dark
  style, watched live through the settings portal.

From the worker:
    {"command": "set", "appearance": "dark"}   saves the choice

The helper exits when Chromium closes the connection.
"""
import json
import os
import re
import struct
import subprocess
import sys
import threading
import time

CONFIG_DIR = os.path.join(
    os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "twine")
APPEARANCE_FILE = os.path.join(CONFIG_DIR, "appearance")
APPEARANCES = ("system", "light", "dark")
PORTAL = ["--session", "--dest", "org.freedesktop.portal.Desktop",
          "--object-path", "/org/freedesktop/portal/desktop"]

send_lock = threading.Lock()
state_lock = threading.Lock()
state = {"appearance": None, "systemDark": None}
monitor = None  # the "gdbus monitor" child process


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    return json.loads(sys.stdin.buffer.read(length))


def send_message(obj):
    data = json.dumps(obj).encode()
    with send_lock:
        sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
        sys.stdout.buffer.flush()


def saved_appearance():
    try:
        with open(APPEARANCE_FILE, encoding="utf-8") as f:
            value = f.read().strip()
    except OSError:
        return "system"
    return value if value in APPEARANCES else "system"


def read_system_dark():
    try:
        out = subprocess.run(
            ["gdbus", "call", *PORTAL, "--method", "org.freedesktop.portal.Settings.ReadOne",
             "org.freedesktop.appearance", "color-scheme"],
            capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "uint32 1" in out


def update(**changes):
    """Merge changes into the state and tell the worker if anything changed."""
    with state_lock:
        new = {**state, **changes}
        if new == state:
            return
        state.update(new)
        snapshot = dict(state)
    send_message(snapshot)


def watch_system_style():
    """Follow GNOME's light/dark style through the portal's SettingChanged signal."""
    global monitor
    try:
        monitor = subprocess.Popen(["gdbus", "monitor", *PORTAL],
                                   stdout=subprocess.PIPE, text=True)
    except OSError:
        return
    for line in monitor.stdout:
        if "SettingChanged" in line and "'color-scheme'" in line:
            match = re.search(r"uint32 (\d+)", line)
            update(systemDark=bool(match and match.group(1) == "1"))


def watch_saved_appearance():
    """Pick up changes made outside this helper (the dock-menu actions)."""
    while True:
        time.sleep(1)
        update(appearance=saved_appearance())


def main():
    update(appearance=saved_appearance(), systemDark=read_system_dark())
    threading.Thread(target=watch_system_style, daemon=True).start()
    threading.Thread(target=watch_saved_appearance, daemon=True).start()

    while True:
        msg = read_message()
        if msg is None:
            break  # Chromium closed the connection.
        if msg.get("command") == "set" and msg.get("appearance") in APPEARANCES:
            os.makedirs(CONFIG_DIR, exist_ok=True)
            with open(APPEARANCE_FILE, "w", encoding="utf-8") as f:
                f.write(msg["appearance"] + "\n")
            update(appearance=msg["appearance"])
    if monitor is not None:
        monitor.terminate()
    os._exit(0)


if __name__ == "__main__":
    main()
