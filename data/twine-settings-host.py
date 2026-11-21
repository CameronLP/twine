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


# ---------------------------------------------------------------------------
# Minimum window size.
#
# LINE's page needs at least 680x490 (with Twine's layout change in
# twine-layout.js, which lets the chat list shrink); a smaller window gets
# scroll bars on both sides of the whole page. 680px is less than half of
# most screens, so GNOME still offers half-screen snapping, which it doesn't
# when the minimum width is more than half the screen. Extensions can't give a window a minimum size, and
# Chromium sets none on its X11 window, so you could drag Twine smaller than
# that. This sets the minimum in the window's WM_NORMAL_HINTS, which GNOME's
# window manager enforces while you resize. Chromium keeps hints set by
# others when it updates its own. The check repeats every second, so a later
# rewrite by Chromium is undone.
#
# X11 sizes are in physical pixels, so the minimum (in the same logical pixels
# as LINE's layout) is multiplied by the scale, Xft.dpi / 96, which is also
# what Chromium uses.
# ---------------------------------------------------------------------------
MIN_WIDTH, MIN_HEIGHT = 680, 490
# The --app window's X11 class: the instance name Chromium derives from the
# splash URL, then the --class the launcher passes.
MAIN_WINDOW_CLASS = ("app_share_twine_splash.html",
                     os.environ.get("FLATPAK_ID", "io.github.twinechat.Twine"))
P_MIN_SIZE = 1 << 4


def enforce_min_window_size():
    import ctypes
    from ctypes import (POINTER, Structure, byref, c_char_p, c_int, c_long,
                        c_ulong, c_void_p)

    class XSizeHints(Structure):
        _fields_ = [("flags", c_long)] + [(name, c_int) for name in (
            "x", "y", "width", "height", "min_width", "min_height",
            "max_width", "max_height", "width_inc", "height_inc",
            "min_aspect_x", "min_aspect_y", "max_aspect_x", "max_aspect_y",
            "base_width", "base_height", "win_gravity")]

    class XClassHint(Structure):
        _fields_ = [("res_name", c_void_p), ("res_class", c_void_p)]

    try:
        x = ctypes.CDLL("libX11.so.6")
    except OSError:
        return
    x.XOpenDisplay.restype = c_void_p
    x.XOpenDisplay.argtypes = [c_char_p]
    x.XDefaultRootWindow.restype = c_ulong
    x.XDefaultRootWindow.argtypes = [c_void_p]
    x.XInternAtom.restype = c_ulong
    x.XInternAtom.argtypes = [c_void_p, c_char_p, c_int]
    x.XGetWindowProperty.argtypes = [
        c_void_p, c_ulong, c_ulong, c_long, c_long, c_int, c_ulong,
        POINTER(c_ulong), POINTER(c_int), POINTER(c_ulong), POINTER(c_ulong),
        POINTER(c_void_p)]
    x.XFree.argtypes = [c_void_p]
    x.XGetClassHint.argtypes = [c_void_p, c_ulong, POINTER(XClassHint)]
    x.XGetWMNormalHints.argtypes = [c_void_p, c_ulong, POINTER(XSizeHints), POINTER(c_long)]
    x.XSetWMNormalHints.argtypes = [c_void_p, c_ulong, POINTER(XSizeHints)]
    x.XFlush.argtypes = [c_void_p]

    # Xlib's default error handler exits the process, and a window can close
    # between listing it and reading it. Ignore such errors instead.
    error_handler_type = ctypes.CFUNCTYPE(c_int, c_void_p, c_void_p)
    ignore_errors = error_handler_type(lambda display, event: 0)
    x.XSetErrorHandler(ignore_errors)

    display = x.XOpenDisplay(None)
    if not display:
        return  # Not running on X11 (e.g. --ozone-platform=wayland).
    root = x.XDefaultRootWindow(display)
    client_list = x.XInternAtom(display, b"_NET_CLIENT_LIST", 0)
    resource_manager = x.XInternAtom(display, b"RESOURCE_MANAGER", 0)
    any_type, xa_string, xa_window = 0, 31, 33

    def get_property(window, prop, prop_type):
        actual_type, actual_format = c_ulong(), c_int()
        nitems, after, data = c_ulong(), c_ulong(), c_void_p()
        if x.XGetWindowProperty(display, window, prop, 0, 1 << 20, 0, prop_type,
                                byref(actual_type), byref(actual_format),
                                byref(nitems), byref(after), byref(data)) != 0 or not data:
            return None
        try:
            if actual_format.value == 32:  # Stored as C longs.
                return list(ctypes.cast(data, POINTER(c_ulong))[:nitems.value])
            return ctypes.string_at(data, nitems.value)
        finally:
            x.XFree(data)

    def scale():
        resources = get_property(root, resource_manager, xa_string) or b""
        match = re.search(rb"^Xft\.dpi:\s*([\d.]+)", resources, re.MULTILINE)
        return float(match.group(1)) / 96 if match else 1.0

    def is_main_window(window):
        hint = XClassHint()
        if not x.XGetClassHint(display, window, byref(hint)):
            return False
        names = []
        for pointer in (hint.res_name, hint.res_class):
            names.append(ctypes.string_at(pointer).decode(errors="replace") if pointer else "")
            if pointer:
                x.XFree(pointer)
        return tuple(names) == MAIN_WINDOW_CLASS

    while True:
        factor = scale()
        min_width, min_height = round(MIN_WIDTH * factor), round(MIN_HEIGHT * factor)
        for window in get_property(root, client_list, xa_window) or []:
            if not is_main_window(window):
                continue
            hints, supplied = XSizeHints(), c_long()
            x.XGetWMNormalHints(display, window, byref(hints), byref(supplied))
            if hints.flags & P_MIN_SIZE:
                if hints.min_width >= min_width and hints.min_height >= min_height:
                    continue
                min_width = max(min_width, hints.min_width)
                min_height = max(min_height, hints.min_height)
            hints.flags |= P_MIN_SIZE
            hints.min_width, hints.min_height = min_width, min_height
            x.XSetWMNormalHints(display, window, byref(hints))
        x.XFlush(display)
        time.sleep(1)


def main():
    update(appearance=saved_appearance(), systemDark=read_system_dark())
    threading.Thread(target=watch_system_style, daemon=True).start()
    threading.Thread(target=watch_saved_appearance, daemon=True).start()
    threading.Thread(target=enforce_min_window_size, daemon=True).start()

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
