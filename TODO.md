# To do

Twine should follow GNOME's conventions and workflow: use GNOME's own
mechanisms (portals, standard shortcuts, notifications) rather than
Twine-specific ones.

- **Open images inside Twine.** Clicking a photo in a chat opens it in a new
  window. Show it in an overlay or popover inside the main window instead.
- **Translation.** Add a way to translate messages.
- **Keep running in the background.** Closing the window quits Chromium, so
  new messages don't notify until Twine is opened again. Use GNOME's
  Background portal, so Twine is listed under Background Apps in Quick
  Settings and can be stopped from there.
- **Start at login (optional).** Offer it as a setting and ask through the
  Background portal's autostart request, so GNOME shows its usual permission
  prompt.
- **Standard shortcuts.** Ctrl+Q quits, Ctrl+W closes the window, and Ctrl+?
  shows a list of shortcuts, as in other GNOME apps.
