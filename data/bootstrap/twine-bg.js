// Twine bootstrap service worker. It wraps LINE's background.js and puts LINE
// into Twine's window once the extension has loaded.
//
// Chromium loads command-line extensions asynchronously, so starting it with
// --app=chrome-extension://…/index.html can fail with ERR_BLOCKED_BY_CLIENT.
// Instead, the launcher opens a local splash page (file:///app/share/twine/
// splash.html), which always loads and keeps Chromium alive, and this worker
// navigates that window to LINE.
import "./background.js";

const MAIN_URL = chrome.runtime.getURL("index.html");

// LINE's background.js stores its window ID under this storage.local key.
// Twine uses the same key so LINE's own logic stays consistent.
const getMainWindow = async () => (await chrome.storage.local.get("mainWindow")).mainWindow ?? null;
const setMainWindow = (id) => chrome.storage.local.set({ mainWindow: id });

async function openNewMainWindow() {
  const win = await chrome.windows.create({
    url: MAIN_URL, type: "popup", focused: true, width: 900, height: 680,
  });
  await setMainWindow(win.id);
}

// Find the splash window. The worker can start before Chromium has created
// the window, so keep looking for a while before giving up.
async function findSplashWindow(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The splash is an --app window; getAll() skips those unless asked.
    const windows = await chrome.windows.getAll({
      populate: true, windowTypes: ["normal", "popup", "app"],
    });
    const win = windows.find((w) => w.tabs && w.tabs.length);
    if (win) return win;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

// Navigate the splash window (the only window at startup) to LINE.
async function adoptSplashWindow() {
  const win = await findSplashWindow();
  if (!win) return openNewMainWindow();
  await chrome.tabs.update(win.tabs[0].id, { url: MAIN_URL });
  await setMainWindow(win.id);
}

// Focus the LINE window, or reopen it if it's gone.
async function focusMainWindow() {
  const id = await getMainWindow();
  if (id !== null) {
    try {
      await chrome.windows.update(id, { focused: true });
      return;
    } catch {
      // The window no longer exists.
    }
  }
  await openNewMainWindow();
}

// A second launch of Twine opens twine-activate.html, which sends this message.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg !== "twine:activate") return;
  focusMainWindow().finally(() => {
    if (sender.tab) chrome.windows.remove(sender.tab.windowId).catch(() => {});
  });
});

// Registering these listeners makes sure Chromium starts this worker at launch.
chrome.runtime.onStartup.addListener(() => {});
chrome.runtime.onInstalled.addListener(() => {});

// Adopt the splash window once per browser session. Session storage is cleared
// when Chromium exits, so later service-worker restarts don't run this again.
(async () => {
  const { twineStarted } = await chrome.storage.session.get("twineStarted");
  if (twineStarted) return;
  await chrome.storage.session.set({ twineStarted: true });
  await adoptSplashWindow();
})().catch((e) => console.error("Twine: bootstrap failed", e));
