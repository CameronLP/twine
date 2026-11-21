// Twine: make LINE's notifications behave like other GNOME apps' notifications.
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
// LINE also clears each notification itself a few seconds after showing it,
// its way of taking a requireInteraction notification off the screen again.
// With normal notifications, GNOME already hides the banner by itself, and
// LINE's clear would also remove the notification from GNOME's notification
// list, so missed messages wouldn't be there to look at later. So clears are
// ignored while the Twine window isn't focused: the notification stays in the
// list until you dismiss or click it. While you're in the Twine window, LINE's
// clears go through, so it can tidy up notifications for chats you're reading.
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

  // clear(id[, callback]): skipped (reported as "not cleared") while the
  // window isn't focused. A window hidden by "Run in Background" still looks
  // focused to the page, so the bootstrap worker reports that separately
  // (twineHidden).
  let hidden = false;
  chrome.storage.session.get("twineHidden", ({ twineHidden }) => { hidden = Boolean(twineHidden); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.twineHidden) hidden = Boolean(changes.twineHidden.newValue);
  });
  const clear = api.clear.bind(api);
  api.clear = (id, callback) => {
    if (document.hasFocus() && !hidden) return clear(id, callback);
    if (typeof callback === "function") {
      callback(false);
      return undefined;
    }
    return Promise.resolve(false);
  };
})();
