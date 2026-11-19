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

// Close every window so Chromium exits; the launcher then restarts Twine.
async function quitTwine() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal", "popup", "app"] });
  await Promise.all(windows.map((w) => chrome.windows.remove(w.id).catch(() => {})));
}

// A second launch of Twine opens twine-activate.html, which sends these messages.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg === "twine:quit") quitTwine();
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg !== "twine:activate") return;
  focusMainWindow().finally(() => {
    if (sender.tab) chrome.windows.remove(sender.tab.windowId).catch(() => {});
  });
});

// Appearance submenu in the window's right-click menu. Twine's settings live
// outside Chromium, so they are read and written through Twine's native
// messaging helper (/app/libexec/twine-settings-host).
const SETTINGS_HOST = "io.github.twinechat.twine";
const APPEARANCES = { system: "Follow System", light: "Light", dark: "Dark" };
const MENU_PREFIX = "twine-appearance-";

const settings = (message) => chrome.runtime.sendNativeMessage(SETTINGS_HOST, message);

async function setUpAppearanceMenu() {
  let current = "system";
  try {
    current = (await settings({ command: "get" })).appearance ?? "system";
  } catch (e) {
    console.warn("Twine: settings helper unavailable", e);
  }
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: "twine-appearance", title: "Appearance", contexts: ["all"] });
  for (const [value, title] of Object.entries(APPEARANCES)) {
    chrome.contextMenus.create({
      id: MENU_PREFIX + value,
      parentId: "twine-appearance",
      title,
      type: "radio",
      checked: value === current,
      contexts: ["all"],
    });
  }
}

// Chromium only reads forced dark mode at startup, so save the choice and
// restart: closing all windows makes Chromium exit, and the launcher starts it
// again because the helper set the restart flag.
chrome.contextMenus.onClicked.addListener(async (info) => {
  const id = String(info.menuItemId);
  if (!id.startsWith(MENU_PREFIX)) return;
  const appearance = id.slice(MENU_PREFIX.length);
  const { appearance: current } = await settings({ command: "get" });
  if (appearance === current) return;
  const result = await settings({ command: "set", appearance, restart: true });
  if (result.ok) await quitTwine();
});

setUpAppearanceMenu();

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
