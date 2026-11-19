// Twine bootstrap service worker. It wraps LINE's background.js and opens the
// LINE window once the extension is actually loaded. Opening it from the
// command line with --app races extension loading (ERR_BLOCKED_BY_CLIENT).
import { openMainWindow } from "./twine-hook.js";
import "./background.js";

// A second launch of Twine opens twine-activate.html, which sends this message.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg !== "twine:activate") return;
  openMainWindow();
  if (sender.tab && sender.tab.windowId !== undefined) {
    chrome.windows.remove(sender.tab.windowId).catch(() => {});
  }
});

// Open the window once per browser session. Session storage is cleared when
// Chromium exits, so later service-worker restarts don't reopen it.
(async () => {
  const { twineStarted } = await chrome.storage.session.get("twineStarted");
  if (twineStarted) return;
  await chrome.storage.session.set({ twineStarted: true });
  openMainWindow();
})();
