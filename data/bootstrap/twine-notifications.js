// Twine: let GNOME's Do Not Disturb hide LINE's notifications.
//
// LINE creates every notification with requireInteraction: true (and clears it
// itself after a while). Chromium on Linux sends such notifications to GNOME
// with urgency "critical" and no timeout, and GNOME shows critical
// notifications even when Do Not Disturb is on, as it should for alarms and
// low-battery warnings. So LINE's messages broke through Do Not Disturb.
//
// This drops requireInteraction before Chromium sees it. Chromium then sends
// normal-urgency notifications, which GNOME treats like those of any other
// app: a banner that moves to the notification list, hidden during Do Not
// Disturb.
//
// It runs from <head>, before LINE's own code (main.js, loaded with defer),
// so LINE only ever sees the wrapped functions.
(() => {
  const api = chrome.notifications;
  if (!api) return;

  // create(options), create(id, options), with or without a callback; and
  // update(id, options[, callback]). Copy the options without
  // requireInteraction and keep everything else as LINE passed it.
  const withoutRequireInteraction = (args) =>
    args.map((arg) => {
      if (arg && typeof arg === "object" && "requireInteraction" in arg) {
        const { requireInteraction, ...options } = arg;
        return options;
      }
      return arg;
    });

  for (const name of ["create", "update"]) {
    const original = api[name].bind(api);
    api[name] = (...args) => original(...withoutRequireInteraction(args));
  }
})();
