#!/usr/bin/python3
"""Twine settings helper (Chromium native messaging host).

Twine's bootstrap service worker keeps a connection open to this program
(chrome.runtime.connectNative("io.github.twinechat.twine")). Messages use
Chromium's native messaging framing: a 4-byte native-endian length followed
by UTF-8 JSON.

To the worker, sent at start and whenever something changes:
    {"appearance": "system" | "light" | "dark", "systemDark": true | false,
     "background": true | false, "canHide": true | false,
     "backgroundAllowed": true | false | null, "portalNotifications": true | false,
     "autostart": true | false, "startHidden": true | false}
  "appearance" is Twine's saved choice ($XDG_CONFIG_HOME/twine/appearance,
  which the dock-menu actions also write). "systemDark" is GNOME's light/dark
  style, watched live through the settings portal. "background" is the saved
  "Run in Background" setting ($XDG_CONFIG_HOME/twine/background, on unless
  it says "off"). "canHide" turns true once the helper has found the main
  window on X11, so it can hide and show it. "backgroundAllowed" is GNOME's
  answer to Twine's background permission request (null until it answers,
  or when there is no background portal). "portalNotifications" is true when
  GNOME's notification portal can be used. "autostart" is the saved "Start at
  Login" setting ($XDG_CONFIG_HOME/twine/autostart, off unless it says "on").
  "startHidden" is true when GNOME started Twine at login, so the window should
  start hidden (TWINE_START_HIDDEN, set by the launcher).
    {"event": "notification-clicked", "id": "..."}
  is sent when one of Twine's notifications is clicked, and
    {"event": "activate"} / {"event": "quit"}
  when GNOME asks Twine to show itself or to quit (see "D-Bus activation").

From the worker:
    {"command": "set", "appearance": "dark"}   saves the choice
    {"command": "min-size", "width": 748, "height": 539}
                                               sets the main window's minimum
                                               size, in logical pixels
    {"command": "set-background", "enabled": true}
                                               saves "Run in Background"
    {"command": "set-autostart", "enabled": true}
                                               saves "Start at Login"
    {"command": "hide"} / {"command": "show"}  hides or shows the main window
    {"command": "show-dialog", "dialog": "shortcuts" | "about",
     "style": "default" | "light" | "dark"}    opens Keyboard Shortcuts or About
                                               Twine (twine-dialogs)
    {"command": "notify", "id": "...", "title": "...", "body": "...",
     "icon": "<base64 image>" | null}          shows (or replaces) a notification
    {"command": "withdraw-notification", "id": "..."}
                                               removes one
    {"command": "notify-download", "id": "...", "path": "..."}
                                               says a download finished
                                               (see "Downloads")

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
BACKGROUND_FILE = os.path.join(CONFIG_DIR, "background")
AUTOSTART_FILE = os.path.join(CONFIG_DIR, "autostart")
PORTAL = ["--session", "--dest", "org.freedesktop.portal.Desktop",
          "--object-path", "/org/freedesktop/portal/desktop"]

send_lock = threading.Lock()
state_lock = threading.Lock()
state = {"appearance": None, "systemDark": None,
         "background": None, "canHide": False, "backgroundAllowed": None,
         "portalNotifications": False, "autostart": None,
         "startHidden": os.environ.get("TWINE_START_HIDDEN") == "1"}
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


def saved_background():
    try:
        with open(BACKGROUND_FILE, encoding="utf-8") as f:
            return f.read().strip() != "off"
    except OSError:
        return True  # On by default.


def saved_autostart():
    try:
        with open(AUTOSTART_FILE, encoding="utf-8") as f:
            return f.read().strip() == "on"
    except OSError:
        return False  # Off by default.


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
# LINE's page needs at least 680x490 at 100% zoom (with Twine's layout change
# in twine-layout.js, which lets the chat list shrink), and proportionally more
# when zoomed in; a smaller window gets scroll bars on both sides of the whole
# page. The bootstrap worker (twine-bg.js) works out the minimum for the
# current zoom level and sends it here ("min-size"); until it does, 680x490 is
# used. 680px is less than half of most screens, so GNOME still offers
# half-screen snapping, which it doesn't when the minimum width is more than
# half the screen.
#
# Extensions can't give a window a minimum size, and Chromium sets none on its
# X11 window, so you could drag Twine smaller than that. This sets the minimum
# in the window's WM_NORMAL_HINTS, which GNOME's window manager enforces while
# you resize. Chromium keeps hints set by others when it updates its own. The
# check repeats every second, so a later rewrite by Chromium is undone.
#
# X11 sizes are in physical pixels, so the minimum (in the same logical pixels
# as LINE's layout) is multiplied by the scale, Xft.dpi / 96, which is also
# what Chromium uses.
# ---------------------------------------------------------------------------
MIN_WIDTH, MIN_HEIGHT = 680, 490
min_size = (MIN_WIDTH, MIN_HEIGHT)  # Logical pixels; updated by "min-size".
min_size_changed = threading.Event()
# The --app window's X11 class: the instance name Chromium derives from the
# splash URL, then the --class the launcher passes. LINE's popup windows get
# the same class (see choose_main_window).
main_window = None  # The main window's X11 ID, once found.
main_window_found = threading.Event()
MAIN_WINDOW_CLASS = ("app_share_twine_splash.html",
                     os.environ.get("FLATPAK_ID", "io.github.twinechat.Twine"))
P_MIN_SIZE = 1 << 4


def enforce_min_window_size():
    global main_window
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
    x.XQueryTree.argtypes = [
        c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_ulong),
        POINTER(POINTER(c_ulong)), POINTER(ctypes.c_uint)]

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

    def is_twine_window(window):
        hint = XClassHint()
        if not x.XGetClassHint(display, window, byref(hint)):
            return False
        names = []
        for pointer in (hint.res_name, hint.res_class):
            names.append(ctypes.string_at(pointer).decode(errors="replace") if pointer else "")
            if pointer:
                x.XFree(pointer)
        return tuple(names) == MAIN_WINDOW_CLASS

    net_wm_name = x.XInternAtom(display, b"_NET_WM_NAME", 0)

    def is_titled_twine(window):
        return b"Twine" in (get_property(window, net_wm_name, any_type) or b"")

    def hidden_main_window():
        """The main window while "Run in Background" has it hidden. Withdrawn
        windows aren't in _NET_CLIENT_LIST, so a helper started after the
        window was hidden (the bootstrap worker restarts when idle, and starts
        a new helper with it) has to look among the root window's children."""
        root_return, parent_return = c_ulong(), c_ulong()
        children, count = POINTER(c_ulong)(), ctypes.c_uint()
        if not x.XQueryTree(display, root, byref(root_return), byref(parent_return),
                            byref(children), byref(count)):
            return None
        try:
            windows = children[:count.value]
        finally:
            if children:
                x.XFree(children)
        for window in windows:
            if is_twine_window(window) and is_titled_twine(window):
                return window
        return None

    def choose_main_window(candidates):
        """LINE's popup windows (photo viewer, popped-out chats) have the same
        class and role as the main window. The main window is the one titled
        "Twine" (twine-title.js), shown or hidden; otherwise the oldest (lowest
        ID). At start, it's the only window, so it's found before any popup
        opens."""
        for window in candidates:
            if is_titled_twine(window):
                return window
        hidden = hidden_main_window()
        if hidden is not None:
            return hidden
        return min(candidates) if candidates else None

    while True:
        factor = scale()
        min_width, min_height = (round(value * factor) for value in min_size)
        # Twine's windows: the main window and LINE's popups. Keep the main
        # window once found, also while it's hidden ("Run in Background"
        # withdraws it, which takes it out of the client list); choose again
        # only when it no longer exists.
        candidates = [w for w in get_property(root, client_list, xa_window) or []
                      if is_twine_window(w)]
        if main_window is None or not is_twine_window(main_window):
            chosen = choose_main_window(candidates)
            if chosen is not None:
                main_window = chosen
                main_window_found.set()
                update(canHide=True)
                if state["background"] or state["autostart"]:
                    threading.Thread(target=request_background, daemon=True).start()
        # The minimum size is the main window's only; popups keep LINE's sizes.
        for window in [main_window] if main_window in candidates else []:
            hints, supplied = XSizeHints(), c_long()
            x.XGetWMNormalHints(display, window, byref(hints), byref(supplied))
            # Set the minimum exactly, so it also goes down after zooming out.
            if hints.flags & P_MIN_SIZE and (hints.min_width, hints.min_height) == (min_width, min_height):
                continue
            hints.flags |= P_MIN_SIZE
            hints.min_width, hints.min_height = min_width, min_height
            x.XSetWMNormalHints(display, window, byref(hints))
        x.XFlush(display)
        # Check again in a second, or right away when the minimum changes.
        min_size_changed.wait(1)
        min_size_changed.clear()


# ---------------------------------------------------------------------------
# Running in the background.
#
# LINE's page keeps the connection and shows the notifications, so it must
# keep running after the window is closed. With "Run in Background" on, the
# bootstrap worker stops the close and asks this helper to hide the window
# instead: it is withdrawn on X11 (XWithdrawWindow), like a closed window. GNOME
# then sees Twine as running with no windows, which is how it recognizes
# background apps, and lists it under Background Apps in Quick Settings.
# Chromium doesn't notice, so LINE's page keeps running at full speed.
# Showing the window maps it again.
#
# Twine asks GNOME for permission to run in the background through the
# Background portal, the way GNOME apps do. GNOME asks the user the first time
# and remembers the answer (Settings → Apps → Twine). If it's denied, the
# worker lets the window close (and Twine quit) instead of hiding it.
#
# The same request also sets "Start at Login": with autostart, GNOME adds
# Twine to the login items, started as "twine --twine-autostart", and without
# it removes Twine again. So every request carries the saved choice; a request
# without it would turn autostart off. Started at login, Twine starts hidden
# when "Run in Background" is on, so no window opens at login.
# ---------------------------------------------------------------------------
command_display = None  # The main thread's X11 connection, for hide/show.


def set_window_visible(visible):
    global command_display
    # A helper that has just started may not have found the window yet.
    main_window_found.wait(3)
    if main_window is None:
        return
    import ctypes
    from ctypes import c_char_p, c_int, c_ulong, c_void_p
    try:
        x = ctypes.CDLL("libX11.so.6")
    except OSError:
        return
    x.XOpenDisplay.restype = c_void_p
    x.XOpenDisplay.argtypes = [c_char_p]
    x.XWithdrawWindow.argtypes = [c_void_p, c_ulong, c_int]
    x.XMapWindow.argtypes = [c_void_p, c_ulong]
    x.XFlush.argtypes = [c_void_p]
    command_display = command_display or x.XOpenDisplay(None)
    if not command_display:
        return
    if visible:
        x.XMapWindow(command_display, main_window)
    else:
        x.XWithdrawWindow(command_display, main_window, 0)
    x.XFlush(command_display)


background_requested = threading.Lock()


def request_background():
    """Ask GNOME, through the Background portal, to let Twine keep running
    without a window (and to start it at login, if chosen), and report the
    answer as "backgroundAllowed" and "autostart"."""
    if not background_requested.acquire(blocking=False):
        return  # A request is already waiting for an answer.
    try:
        import gi
        gi.require_version("Gio", "2.0")
        from gi.repository import Gio, GLib
        bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        # This thread runs its own GLib main loop; signals are delivered in the
        # main context that is the thread's default when subscribing.
        context = GLib.MainContext.new()
        context.push_thread_default()
        # The portal answers with a Response signal on a request object whose
        # path follows from our bus name and a token we choose. Subscribe
        # before asking, so a quick answer isn't missed.
        token = f"twine_{os.getpid()}_{int(time.time())}"
        sender = bus.get_unique_name()[1:].replace(".", "_")
        path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
        loop = GLib.MainLoop.new(context, False)

        def on_response(connection, sender_name, object_path, interface, signal, params):
            code, results = params.unpack()
            update(backgroundAllowed=code == 0 and bool(results.get("background")))
            if code == 0 and want_autostart and not results.get("autostart"):
                print("twine-settings-host: GNOME didn't allow starting at login", file=sys.stderr)
            loop.quit()

        subscription = bus.signal_subscribe(
            "org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response",
            path, None, Gio.DBusSignalFlags.NONE, on_response)
        want_autostart = saved_autostart()
        options = {
            "handle_token": GLib.Variant("s", token),
            "reason": GLib.Variant("s", "To keep receiving LINE messages after you close the window"),
            "autostart": GLib.Variant("b", want_autostart),
            "commandline": GLib.Variant("as", ["twine", "--twine-autostart"]),
            "dbus-activatable": GLib.Variant("b", False),
        }
        parent = f"x11:{main_window:x}" if main_window else ""
        try:
            bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                          "org.freedesktop.portal.Background", "RequestBackground",
                          GLib.Variant("(sa{sv})", (parent, options)), None,
                          Gio.DBusCallFlags.NONE, -1, None)
        except GLib.Error:
            # No background portal: nothing will stop Twine from running.
            bus.signal_unsubscribe(subscription)
            update(backgroundAllowed=None)
            return
        timeout = GLib.timeout_source_new_seconds(600)  # Don't wait forever.
        timeout.set_callback(lambda *args: loop.quit())
        timeout.attach(context)
        loop.run()
        bus.signal_unsubscribe(subscription)
    except Exception as e:  # Never let this crash the helper.
        print(f"twine-settings-host: background request failed: {e}", file=sys.stderr)
    finally:
        background_requested.release()


# ---------------------------------------------------------------------------
# Notifications, through GNOME's notification portal (see
# twine-notifications.js). Clicks come back through D-Bus activation (below).
# ---------------------------------------------------------------------------
PORTAL_NAME = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
NOTIFICATION_IFACE = "org.freedesktop.portal.Notification"
notification_bus = None
notification_portal_version = 0


# ---------------------------------------------------------------------------
# D-Bus activation. GNOME talks to D-Bus activatable apps (DBusActivatable=true
# in the desktop file) through the org.freedesktop.Application interface on
# the bus name that is their app ID: Activate when opened from the app grid,
# ActivateAction for the dock menu's actions, clicked notifications, and
# "quit" (Background Apps in Quick Settings).
# If nobody owns the name, the bus starts Twine first
# (io.github.twinechat.Twine.service), and the call waits until this helper
# owns it. This is how clicking a notification opens Twine after it has quit.
# ---------------------------------------------------------------------------
APP_ID = os.environ.get("FLATPAK_ID", "io.github.twinechat.Twine")
APP_PATH = "/" + APP_ID.replace(".", "/")
APPLICATION_XML = """
<node>
  <interface name="org.freedesktop.Application">
    <method name="Activate"><arg type="a{sv}" name="platform_data" direction="in"/></method>
    <method name="Open">
      <arg type="as" name="uris" direction="in"/>
      <arg type="a{sv}" name="platform_data" direction="in"/>
    </method>
    <method name="ActivateAction">
      <arg type="s" name="action_name" direction="in"/>
      <arg type="av" name="parameter" direction="in"/>
      <arg type="a{sv}" name="platform_data" direction="in"/>
    </method>
  </interface>
</node>
"""


def save_appearance(value):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(APPEARANCE_FILE, "w", encoding="utf-8") as f:
        f.write(value + "\n")
    update(appearance=value)


def complete_startup(platform_data):
    """End the startup notification GNOME began when it asked Twine to open.
    GNOME shows a busy cursor until the app reports that it has started, or
    until a timeout of several seconds. Twine doesn't open a new window for
    these requests (it shows or focuses its existing one), so nothing would
    report it. The ID is put on the main window (_NET_STARTUP_ID, which also
    tells the window manager the request was the user's, for focus), and the
    X11 "remove" startup message is sent for it."""
    startup_id = platform_data.get("desktop-startup-id") or platform_data.get("activation-token")
    if not startup_id:
        return
    try:
        send_startup_complete(startup_id)
    except Exception as e:
        # Never let this keep the D-Bus call from being answered.
        print(f"twine-settings-host: can't complete startup: {e}", file=sys.stderr)


def send_startup_complete(startup_id):
    import ctypes
    from ctypes import Structure, byref, c_char, c_char_p, c_int, c_long, c_uint, c_ulong, c_void_p
    try:
        x = ctypes.CDLL("libX11.so.6")
    except OSError:
        return
    x.XOpenDisplay.restype = c_void_p
    x.XOpenDisplay.argtypes = [c_char_p]
    x.XCloseDisplay.argtypes = [c_void_p]
    x.XDefaultRootWindow.restype = c_ulong
    x.XDefaultRootWindow.argtypes = [c_void_p]
    x.XInternAtom.restype = c_ulong
    x.XInternAtom.argtypes = [c_void_p, c_char_p, c_int]
    x.XChangeProperty.argtypes = [c_void_p, c_ulong, c_ulong, c_ulong, c_int, c_int, c_char_p, c_int]
    x.XCreateSimpleWindow.restype = c_ulong
    x.XCreateSimpleWindow.argtypes = [c_void_p, c_ulong, c_int, c_int, c_uint, c_uint, c_uint, c_ulong, c_ulong]
    x.XDestroyWindow.argtypes = [c_void_p, c_ulong]
    x.XSendEvent.argtypes = [c_void_p, c_ulong, c_int, c_long, c_void_p]
    x.XSync.argtypes = [c_void_p, c_int]

    class XClientMessageEvent(Structure):
        _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int),
                    ("display", c_void_p), ("window", c_ulong), ("message_type", c_ulong),
                    ("format", c_int),
                    # A union with long[5] in Xlib, so it's aligned like a long.
                    ("data", c_long * 5),
                    ("pad", c_char * 96)]  # XSendEvent reads a whole XEvent (192 bytes).

    display = x.XOpenDisplay(None)
    if not display:
        return
    try:
        root = x.XDefaultRootWindow(display)
        encoded = startup_id.encode()
        if main_window is not None:
            x.XChangeProperty(display, main_window, x.XInternAtom(display, b"_NET_STARTUP_ID", 0),
                              x.XInternAtom(display, b"UTF8_STRING", 0), 8, 0,
                              encoded, len(encoded))
        # The startup-notification protocol: the message travels in 20-byte
        # pieces, the first as _NET_STARTUP_INFO_BEGIN, from a window of ours.
        quoted = encoded.replace(b"\\", b"\\\\").replace(b'"', b'\\"')
        message = b'remove: ID="' + quoted + b'"\0'
        sender = x.XCreateSimpleWindow(display, root, -100, -100, 1, 1, 0, 0, 0)
        begin = x.XInternAtom(display, b"_NET_STARTUP_INFO_BEGIN", 0)
        more = x.XInternAtom(display, b"_NET_STARTUP_INFO", 0)
        property_change_mask = 1 << 22
        for offset in range(0, len(message), 20):
            event = XClientMessageEvent(type=33, send_event=1, display=display, window=sender,
                                        message_type=begin if offset == 0 else more, format=8)
            piece = message[offset:offset + 20]
            ctypes.memmove(byref(event, XClientMessageEvent.data.offset), piece, len(piece))
            x.XSendEvent(display, root, 0, property_change_mask, byref(event))
        x.XSync(display, 0)
        x.XDestroyWindow(display, sender)
        x.XSync(display, 0)
    finally:
        x.XCloseDisplay(display)


def on_application_call(connection, sender, path, interface, method, params, invocation):
    if method in ("Activate", "Open"):
        send_message({"event": "activate"})
        complete_startup(params.unpack()[-1])
    elif method == "ActivateAction":
        action, parameter, platform_data = params.unpack()
        if action == "show-download":
            # A "Download complete" notification (notify_download); the
            # target is the file's path. The click's activation token goes to
            # the file manager, which opens the window, instead of ending it
            # here: without it, GNOME opens the folder behind Twine.
            show_download(str(parameter[0]) if parameter else "", platform_data)
            invocation.return_value(None)
            return
        complete_startup(platform_data)
        if action == "open-chat":
            # The notification's ID, from its default-action-target.
            notification_id = parameter[0] if parameter else ""
            send_message({"event": "notification-clicked", "id": str(notification_id)})
        elif action == "quit":
            # Background Apps in Quick Settings asks apps to quit this way.
            send_message({"event": "quit"})
        elif action.startswith("appearance-") and action[len("appearance-"):] in APPEARANCES:
            save_appearance(action[len("appearance-"):])
        else:
            send_message({"event": "activate"})
    invocation.return_value(None)


def start_dbus():
    """Own Twine's bus name, answer GNOME's app requests, and check for the
    notification portal. Runs its own GLib main loop in this thread."""
    global notification_bus, notification_portal_version
    try:
        import gi
        gi.require_version("Gio", "2.0")
        from gi.repository import Gio, GLib
        context = GLib.MainContext.new()
        context.push_thread_default()
        bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    except Exception as e:
        print(f"twine-settings-host: no D-Bus: {e}", file=sys.stderr)
        return

    try:
        interface = Gio.DBusNodeInfo.new_for_xml(APPLICATION_XML).interfaces[0]
        bus.register_object(APP_PATH, interface, on_application_call, None, None)
        Gio.bus_own_name_on_connection(bus, APP_ID, Gio.BusNameOwnerFlags.NONE, None, None)
    except Exception as e:
        print(f"twine-settings-host: can't own {APP_ID}: {e}", file=sys.stderr)

    try:
        version = bus.call_sync(
            PORTAL_NAME, PORTAL_PATH, "org.freedesktop.DBus.Properties", "Get",
            GLib.Variant("(ss)", (NOTIFICATION_IFACE, "version")), None,
            Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]

        # Clicks are reported to Twine as ActivateAction("open-chat") (above)
        # or, by some portal versions, with this signal.
        def on_action(connection, sender, path, interface, signal, params):
            notification_id = params.unpack()[0]
            if notification_id in download_paths:
                # Portal version 2 appends the platform data (with the
                # activation token) to the parameters.
                parameters = params.unpack()[2]
                platform_data = parameters[-1] if parameters and isinstance(parameters[-1], dict) else {}
                show_download(download_paths[notification_id], platform_data)
                return
            send_message({"event": "notification-clicked", "id": notification_id})

        bus.signal_subscribe(PORTAL_NAME, NOTIFICATION_IFACE, "ActionInvoked", PORTAL_PATH,
                             None, Gio.DBusSignalFlags.NONE, on_action)
        notification_bus, notification_portal_version = bus, version
        update(portalNotifications=True)
    except Exception as e:  # No portal: Chromium shows the notifications.
        print(f"twine-settings-host: notification portal unavailable: {e}", file=sys.stderr)

    GLib.MainLoop.new(context, False).run()


def notify(msg):
    if notification_bus is None:
        return
    import base64
    from gi.repository import Gio, GLib
    notification = {
        "title": GLib.Variant("s", str(msg.get("title") or "LINE")),
        "body": GLib.Variant("s", str(msg.get("body") or "")),
        "priority": GLib.Variant("s", "normal"),
        # GNOME activates this action with the notification's ID (see "D-Bus
        # activation"), starting Twine first if it isn't running.
        "default-action": GLib.Variant("s", "app." + msg.get("action", "open-chat")),
        "default-action-target": GLib.Variant("s", str(msg.get("target", msg["id"]))),
    }
    if notification_portal_version >= 2:
        notification["category"] = GLib.Variant("s", msg.get("category", "im.received"))
    # The notification's picture, or else Twine's app icon (by its icon name,
    # as installed by Flatpak): GNOME doesn't fill in the app icon itself.
    icon = Gio.ThemedIcon.new(APP_ID).serialize()
    if msg.get("icon"):
        try:
            data = GLib.Bytes.new(base64.b64decode(msg["icon"]))
            icon = Gio.BytesIcon.new(data).serialize()
        except (ValueError, TypeError):
            pass

    def add(with_icon):
        options = dict(notification)
        if with_icon:
            options["icon"] = icon
        notification_bus.call_sync(
            PORTAL_NAME, PORTAL_PATH, NOTIFICATION_IFACE, "AddNotification",
            GLib.Variant("(sa{sv})", (str(msg["id"]), options)), None,
            Gio.DBusCallFlags.NONE, 5000, None)

    try:
        add(icon is not None)
    except GLib.Error as e:
        if icon is None:
            print(f"twine-settings-host: notification failed: {e}", file=sys.stderr)
            return
        try:
            add(False)  # The portal may refuse some images; show it without.
        except GLib.Error as e2:
            print(f"twine-settings-host: notification failed: {e2}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Downloads. Chromium's download bubble belongs to its toolbar, which Twine's
# window doesn't have, so it appeared partly off screen in the window's
# top-left corner. The bootstrap worker turns Chromium's download UI off and
# reports finished downloads here instead: a "Download complete" notification
# names the file, and clicking it opens its folder through the OpenURI portal
# (with the file selected, where the file manager supports it).
# ---------------------------------------------------------------------------
download_paths = {}  # notification ID -> file path
last_shown_download = (None, 0.0)  # Some portals report a click twice.


def notify_download(msg):
    path = str(msg.get("path") or "")
    if not path:
        return
    notification_id = str(msg["id"])
    download_paths[notification_id] = path
    notify({
        "id": notification_id,
        "title": "Download complete",
        "body": os.path.basename(path),
        "action": "show-download",
        "target": path,
        "category": "transfer.complete",
    })


def show_download(path, platform_data=None):
    global last_shown_download
    if not path or not os.path.exists(path):
        return
    if last_shown_download[0] == path and time.monotonic() - last_shown_download[1] < 2:
        return
    last_shown_download = (path, time.monotonic())
    platform_data = platform_data or {}
    token = platform_data.get("activation-token") or platform_data.get("desktop-startup-id")
    try:
        from gi.repository import Gio, GLib
        bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        # A plain read-only descriptor: the portal refuses O_PATH ones here.
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
        try:
            fds = Gio.UnixFDList.new_from_array([fd])
        except Exception:
            os.close(fd)
            raise
        bus.call_with_unix_fd_list_sync(
            PORTAL_NAME, PORTAL_PATH, "org.freedesktop.portal.OpenURI", "OpenDirectory",
            GLib.Variant("(sha{sv})", ("", 0, {"activation_token": GLib.Variant("s", token)} if token else {})), None,
            Gio.DBusCallFlags.NONE, 5000, fds, None)
    except Exception as e:
        print(f"twine-settings-host: can't show download: {e}", file=sys.stderr)


def withdraw_notification(notification_id):
    if notification_bus is None:
        return
    from gi.repository import Gio, GLib
    try:
        notification_bus.call_sync(
            PORTAL_NAME, PORTAL_PATH, NOTIFICATION_IFACE, "RemoveNotification",
            GLib.Variant("(s)", (str(notification_id),)), None,
            Gio.DBusCallFlags.NONE, 5000, None)
    except GLib.Error:
        pass


# Twine's dialogs (Keyboard Shortcuts, About Twine): libadwaita's own dialogs,
# real GTK windows run by /app/libexec/twine-dialogs, attached to Twine's
# window. One of each at a time.
dialog_processes = {}


def show_dialog(kind, style):
    if kind not in ("shortcuts", "about"):
        return
    process = dialog_processes.get(kind)
    if process is not None and process.poll() is None:
        return  # Already open.
    command = ["python3", "/app/libexec/twine-dialogs", kind,
               "--style", style if style in ("default", "light", "dark") else "default"]
    if main_window:
        command += ["--parent", hex(main_window)]
    try:
        dialog_processes[kind] = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                                  stdout=subprocess.DEVNULL)
    except OSError as e:
        print(f"twine-settings-host: can't open the {kind} dialog: {e}", file=sys.stderr)


def main():
    global min_size
    update(appearance=saved_appearance(), systemDark=read_system_dark(),
           background=saved_background(), autostart=saved_autostart())
    threading.Thread(target=watch_system_style, daemon=True).start()
    threading.Thread(target=watch_saved_appearance, daemon=True).start()
    threading.Thread(target=enforce_min_window_size, daemon=True).start()
    threading.Thread(target=start_dbus, daemon=True).start()

    while True:
        msg = read_message()
        if msg is None:
            break  # Chromium closed the connection.
        if msg.get("command") == "set" and msg.get("appearance") in APPEARANCES:
            save_appearance(msg["appearance"])
        elif msg.get("command") == "min-size":
            try:
                width, height = int(msg["width"]), int(msg["height"])
            except (KeyError, TypeError, ValueError):
                continue
            if width > 0 and height > 0:
                min_size = (width, height)
                min_size_changed.set()
        elif msg.get("command") == "set-background":
            enabled = bool(msg.get("enabled"))
            os.makedirs(CONFIG_DIR, exist_ok=True)
            with open(BACKGROUND_FILE, "w", encoding="utf-8") as f:
                f.write(("on" if enabled else "off") + "\n")
            update(background=enabled)
            if enabled:
                threading.Thread(target=request_background, daemon=True).start()
        elif msg.get("command") == "set-autostart":
            enabled = bool(msg.get("enabled"))
            os.makedirs(CONFIG_DIR, exist_ok=True)
            with open(AUTOSTART_FILE, "w", encoding="utf-8") as f:
                f.write(("on" if enabled else "off") + "\n")
            update(autostart=enabled)
            # Adds or removes Twine from GNOME's login items.
            threading.Thread(target=request_background, daemon=True).start()
        elif msg.get("command") in ("hide", "show"):
            set_window_visible(msg["command"] == "show")
        elif msg.get("command") == "show-dialog":
            show_dialog(msg.get("dialog"), msg.get("style"))
        elif msg.get("command") == "notify" and msg.get("id"):
            notify(msg)
        elif msg.get("command") == "notify-download" and msg.get("id"):
            notify_download(msg)
        elif msg.get("command") == "withdraw-notification" and msg.get("id"):
            withdraw_notification(msg["id"])
    if monitor is not None:
        monitor.terminate()
    os._exit(0)


if __name__ == "__main__":
    main()
