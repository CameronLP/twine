#!/usr/bin/python3
"""Twine settings helper (Chromium native messaging host).

Twine's bootstrap service worker talks to this program through
chrome.runtime.sendNativeMessage("io.github.twinechat.twine", …) to read and
change Twine's settings, which live outside Chromium in
$XDG_CONFIG_HOME/twine. Messages use Chromium's native messaging framing:
a 4-byte native-endian length followed by UTF-8 JSON.

  {"command": "get"}
      -> {"appearance": "system" | "light" | "dark"}
  {"command": "set", "appearance": "dark", "restart": true}
      -> {"ok": true}   (with restart, the launcher restarts Chromium after
                         the bootstrap closes its windows)
"""
import json
import os
import struct
import sys

CONFIG_DIR = os.path.join(
    os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "twine")
APPEARANCE_FILE = os.path.join(CONFIG_DIR, "appearance")
RESTART_FILE = os.path.join(CONFIG_DIR, "restart")
APPEARANCES = ("system", "light", "dark")


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    return json.loads(sys.stdin.buffer.read(length))


def send_message(obj):
    data = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
    sys.stdout.buffer.flush()


def current_appearance():
    try:
        with open(APPEARANCE_FILE, encoding="utf-8") as f:
            value = f.read().strip()
    except OSError:
        return "system"
    return value if value in APPEARANCES else "system"


def main():
    msg = read_message()
    if not isinstance(msg, dict):
        return
    command = msg.get("command")
    if command == "get":
        send_message({"appearance": current_appearance()})
    elif command == "set":
        appearance = msg.get("appearance")
        if appearance not in APPEARANCES:
            send_message({"error": f"unknown appearance: {appearance!r}"})
            return
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(APPEARANCE_FILE, "w", encoding="utf-8") as f:
            f.write(appearance + "\n")
        if msg.get("restart"):
            open(RESTART_FILE, "w").close()
        send_message({"ok": True})
    else:
        send_message({"error": f"unknown command: {command!r}"})


if __name__ == "__main__":
    main()
