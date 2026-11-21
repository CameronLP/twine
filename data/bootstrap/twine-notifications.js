// Twine: make LINE's notifications behave like other GNOME apps' notifications.
//
// Twine sends LINE's notifications through GNOME's notification portal, the
// way GNOME apps do, instead of letting Chromium send them. Compared with
// Chromium's notifications, they
//
//   - stay in GNOME's notification list after Twine quits (GNOME clears the
//     notifications of a program that sent them the older way when it exits),
//   - have normal priority, so Do Not Disturb hides them (LINE asks for
//     requireInteraction, which Chromium sends as "critical", and GNOME shows
//     critical notifications even during Do Not Disturb),
//   - don't get the "Settings" button Chromium adds to its notifications.
//
// So this wraps chrome.notifications in LINE's page: create() and update()
// hand the title, text and picture to the bootstrap worker (twine-bg.js), which
// passes them to twine-settings-host, which sends them to the portal. When a
// notification is clicked, the worker shows the window and tells this page,
// which calls LINE's own onClicked listeners, so LINE opens the chat as usual.
//
// LINE also clears each notification itself a few seconds after showing it
// (its way of taking a requireInteraction notification off the screen again).
// That would also take it out of GNOME's notification list, so missed messages
// wouldn't be there later. So clears are skipped while the Twine window isn't
// focused, or is hidden by "Run in Background": the notification stays until
// you dismiss or click it. While you're in the Twine window, LINE's clears go
// through, so it can tidy up notifications for chats you're reading.
//
// If the portal isn't available (the worker reports twinePortalNotifications),
// notifications go to Chromium as before, without requireInteraction.
//
// It runs from <head>, before LINE's own code (main.js, loaded with defer),
// so LINE only ever sees the wrapped functions.
(() => {
  const api = chrome.notifications;
  if (!api) return;
  const original = {
    create: api.create.bind(api),
    update: api.update.bind(api),
    clear: api.clear.bind(api),
  };

  // State shared by the worker: whether the main window is hidden (Chromium
  // doesn't notice, so the page still thinks it has focus) and whether the
  // portal can be used.
  let hidden = false;
  let portal = false;
  chrome.storage.session.get(["twineHidden", "twinePortalNotifications"], (values) => {
    hidden = Boolean(values.twineHidden);
    portal = Boolean(values.twinePortalNotifications);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    if (changes.twineHidden) hidden = Boolean(changes.twineHidden.newValue);
    if (changes.twinePortalNotifications) portal = Boolean(changes.twinePortalNotifications.newValue);
  });

  // Chrome's API calls back when a callback is given, and returns a promise
  // otherwise.
  const settle = (callback, value) => {
    if (typeof callback === "function") {
      callback(value);
      return undefined;
    }
    return Promise.resolve(value);
  };

  const withoutRequireInteraction = (args) =>
    args.map((arg) => {
      if (arg && typeof arg === "object" && "requireInteraction" in arg) {
        const { requireInteraction, ...options } = arg;
        return options;
      }
      return arg;
    });

  // The picture, as base64 for the portal. LINE gives data:, blob: or
  // extension URLs, which the page can read.
  async function iconData(url) {
    if (!url) return null;
    try {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    } catch {
      return null;
    }
  }

  const shown = new Map(); // id -> options, so update() can merge
  let counter = 0;

  async function send(id, options) {
    const icon = await iconData(options.iconUrl);
    chrome.runtime
      .sendMessage({
        twineNotification: { id, title: String(options.title ?? ""), body: String(options.message ?? ""), icon },
      })
      .catch(() => {});
  }

  // create(options[, callback]) or create(id, options[, callback])
  api.create = (...args) => {
    if (!portal) return original.create(...withoutRequireInteraction(args));
    const [id, options, callback] = typeof args[0] === "string" ? args : [undefined, ...args];
    const notificationId = id || `twine-${Date.now()}-${counter++}`;
    shown.set(notificationId, options || {});
    send(notificationId, options || {});
    return settle(callback, notificationId);
  };

  // update(id, options[, callback])
  api.update = (id, options, callback) => {
    if (!portal) return original.update(...withoutRequireInteraction([id, options, callback]));
    if (!shown.has(id)) return settle(callback, false);
    const merged = { ...shown.get(id), ...options };
    shown.set(id, merged);
    send(id, merged);
    return settle(callback, true);
  };

  // clear(id[, callback]): skipped (reported as "not cleared") while the
  // window isn't focused or is hidden.
  api.clear = (id, callback) => {
    if (!document.hasFocus() || hidden) return settle(callback, false);
    if (!portal) return original.clear(id, callback);
    const existed = shown.delete(id);
    chrome.runtime.sendMessage({ twineWithdrawNotification: id }).catch(() => {});
    return settle(callback, existed);
  };

  // LINE's click handlers. Chromium never sees portal notifications, so the
  // worker reports clicks and this page calls the handlers itself.
  const clickListeners = new Set();
  const addListener = api.onClicked.addListener.bind(api.onClicked);
  const removeListener = api.onClicked.removeListener.bind(api.onClicked);
  api.onClicked.addListener = (listener) => {
    clickListeners.add(listener);
    addListener(listener);
  };
  api.onClicked.removeListener = (listener) => {
    clickListeners.delete(listener);
    removeListener(listener);
  };
  const CLICKED = "twine:notification-clicked:";
  chrome.runtime.onMessage.addListener((msg) => {
    if (typeof msg !== "string" || !msg.startsWith(CLICKED)) return;
    const id = msg.slice(CLICKED.length);
    shown.delete(id);
    for (const listener of clickListeners) {
      try {
        listener(id);
      } catch (e) {
        console.error("Twine: notification click handler failed", e);
      }
    }
  });
})();
