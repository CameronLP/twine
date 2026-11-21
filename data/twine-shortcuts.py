#!/usr/bin/python3
"""Twine's Keyboard Shortcuts window: libadwaita's own shortcuts dialog
(AdwShortcutsDialog), the one GNOME apps show for Ctrl+?.

twine-settings-host starts it when Ctrl+? is pressed in Twine or Keyboard
Shortcuts is chosen in the ☰ menu. The dialog is a real GTK window, in Twine's
light or dark style, attached to Twine's window like any GNOME modal dialog.
GTK only knows its own windows, so the X11 properties that make it a modal
dialog of Twine's window are set here (see make_modal_dialog_of). GNOME then
attaches it to
Twine's window (the "attach-modal-dialogs" setting): it opens from the top of
that window, moves with it, and dims it.

Usage: twine-shortcuts [--parent XID] [--style default|light|dark]
"""
import argparse
import warnings

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

APP_ID = "io.github.twinechat.Twine"

# The X11 window class, so GNOME shows the window as Twine's (not "python3").
GLib.set_prgname(APP_ID)

# [section, [(title, accelerator)]]
SHORTCUTS = [
    ("General", [
        ("Show Keyboard Shortcuts", "<Control>question"),
        ("Close Window", "<Control>w"),
        ("Quit", "<Control>q"),
    ]),
    ("Zoom", [
        ("Zoom In", "<Control>plus"),
        ("Zoom Out", "<Control>minus"),
        ("Reset Zoom", "<Control>0"),
    ]),
]


def make_modal_dialog_of(window, parent_xid):
    """Re-map the dialog's X11 window as a modal dialog of Twine's window.

    GNOME decides whether to attach a dialog when the window appears, and GTK
    only marks a window as a modal dialog of its own windows. So once GTK has
    shown the window, it is withdrawn, given the properties of a modal dialog
    of Twine's window (WM_TRANSIENT_FOR, _NET_WM_WINDOW_TYPE_DIALOG,
    _NET_WM_STATE_MODAL), and mapped again, which GNOME treats as a new
    window."""
    try:
        gi.require_version("GdkX11", "4.0")
        from gi.repository import GdkX11
    except (ImportError, ValueError):
        return
    surface = window.get_surface()
    if not isinstance(surface, GdkX11.X11Surface):
        return
    import ctypes
    import time
    from ctypes import c_char_p, c_int, c_long, c_ulong, c_void_p
    try:
        x = ctypes.CDLL("libX11.so.6")
    except OSError:
        return
    x.XOpenDisplay.restype = c_void_p
    x.XOpenDisplay.argtypes = [c_char_p]
    x.XInternAtom.restype = c_ulong
    x.XInternAtom.argtypes = [c_void_p, c_char_p, c_int]
    x.XSetTransientForHint.argtypes = [c_void_p, c_ulong, c_ulong]
    x.XChangeProperty.argtypes = [c_void_p, c_ulong, c_ulong, c_ulong, c_int, c_int,
                                  c_void_p, c_int]
    x.XWithdrawWindow.argtypes = [c_void_p, c_ulong, c_int]
    x.XGetWindowProperty.argtypes = [
        c_void_p, c_ulong, c_ulong, c_long, c_long, c_int, c_ulong,
        ctypes.POINTER(c_ulong), ctypes.POINTER(c_int), ctypes.POINTER(c_ulong),
        ctypes.POINTER(c_ulong), ctypes.POINTER(c_void_p)]
    x.XFree.argtypes = [c_void_p]
    x.XMapWindow.argtypes = [c_void_p, c_ulong]
    x.XSync.argtypes = [c_void_p, c_int]
    x.XCloseDisplay.argtypes = [c_void_p]
    display = x.XOpenDisplay(None)
    if not display:
        return
    atom = lambda name: x.XInternAtom(display, name.encode(), 0)  # noqa: E731
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)  # get_xid: fine on X11
        xid = surface.get_xid()

    def wm_state():
        """The window's ICCCM WM_STATE (1 = shown by the window manager), or
        None if the window manager isn't managing it."""
        actual_type, actual_format = c_ulong(), c_int()
        nitems, after, data = c_ulong(), c_ulong(), c_void_p()
        prop = atom("WM_STATE")
        if x.XGetWindowProperty(display, xid, prop, 0, 2, 0, prop, ctypes.byref(actual_type),
                                ctypes.byref(actual_format), ctypes.byref(nitems),
                                ctypes.byref(after), ctypes.byref(data)) != 0 or not data:
            return None
        try:
            return ctypes.cast(data, ctypes.POINTER(c_ulong))[0] if nitems.value else None
        finally:
            x.XFree(data)

    def wait_until(condition, timeout=2.0):
        deadline = time.monotonic() + timeout
        while not condition() and time.monotonic() < deadline:
            time.sleep(0.01)

    # Wait until GNOME has taken the window on, withdraw it, and wait until
    # GNOME has let go of it, so the new map really is a new window to GNOME.
    x.XSync(display, 0)
    wait_until(lambda: wm_state() == 1)
    x.XWithdrawWindow(display, xid, 0)
    x.XSync(display, 0)
    wait_until(lambda: wm_state() in (None, 0))
    x.XSetTransientForHint(display, xid, parent_xid)
    xa_atom = 4
    window_type = (c_long * 1)(atom("_NET_WM_WINDOW_TYPE_DIALOG"))
    x.XChangeProperty(display, xid, atom("_NET_WM_WINDOW_TYPE"), xa_atom, 32, 0, window_type, 1)
    wm_state = (c_long * 2)(atom("_NET_WM_STATE_MODAL"), atom("_NET_WM_STATE_SKIP_TASKBAR"))
    x.XChangeProperty(display, xid, atom("_NET_WM_STATE"), xa_atom, 32, 0, wm_state, 2)
    x.XMapWindow(display, xid)
    x.XSync(display, 0)
    x.XCloseDisplay(display)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent", type=lambda value: int(value, 0), default=0)
    parser.add_argument("--style", choices=("default", "light", "dark"), default="default")
    args = parser.parse_args()

    # NON_UNIQUE: don't register on the bus, where twine-settings-host already
    # owns Twine's name. The app ID still lets GNOME show the window as Twine's.
    app = Adw.Application(application_id=APP_ID, flags=Gio.ApplicationFlags.NON_UNIQUE)

    def on_activate(app):
        # A dialog has only a close button, whatever GNOME's button layout.
        Gtk.Settings.get_default().set_property("gtk-decoration-layout", ":close")
        Adw.StyleManager.get_default().set_color_scheme({
            "light": Adw.ColorScheme.FORCE_LIGHT,
            "dark": Adw.ColorScheme.FORCE_DARK,
        }.get(args.style, Adw.ColorScheme.DEFAULT))

        dialog = Adw.ShortcutsDialog()
        for title, items in SHORTCUTS:
            section = Adw.ShortcutsSection(title=title)
            for item_title, accelerator in items:
                section.add(Adw.ShortcutsItem(title=item_title, accelerator=accelerator))
            dialog.add(section)

        app.hold()  # The dialog's own window isn't one of the app's windows.
        dialog.connect("closed", lambda *_: app.release())

        # Without a parent widget, present() puts the dialog in a window of its
        # own and shows it at once; then it is made Twine's modal dialog.
        dialog.present(None)
        window = dialog.get_root()
        if args.parent and isinstance(window, Gtk.Window):
            make_modal_dialog_of(window, args.parent)

    app.connect("activate", on_activate)
    app.run([])


if __name__ == "__main__":
    main()
