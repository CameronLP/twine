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

// Keep Chromium's browser UI out of Twine. Chromium adds a "Settings" button to
// every notification, which opens chrome://settings in a browser window, and
// shortcuts such as Ctrl+N open a new-tab window. Close any chrome:// page as
// soon as it appears and show the LINE window instead. (The button itself
// can't be removed without patching Chromium.)
function closeBrowserPage(tab) {
  const url = tab.pendingUrl || tab.url || "";
  if (!url.startsWith("chrome://")) return;
  chrome.tabs.remove(tab.id).catch(() => {});
  focusMainWindow();
}
chrome.tabs.onCreated.addListener(closeBrowserPage);
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) closeBrowserPage(tab);
});

// ---------------------------------------------------------------------------
// Appearance (Follow System / Light / Dark), applied live.
//
// LINE's page has no dark theme, so dark mode uses Chromium's auto dark mode.
// The DevTools command Emulation.setAutoDarkModeOverride switches it on or off
// for a page instantly. The worker sends it through chrome.debugger, so no
// debugging port is opened (the launcher passes --silent-debugger-extension-api
// to hide Chromium's "started debugging" bar).
//
// Twine's settings live outside Chromium. A long-lived connection to Twine's
// native messaging helper (/app/libexec/twine-settings-host) reports the
// saved choice and GNOME's light/dark style, and sends updates whenever either
// changes. The open connection also keeps this worker alive, so the debugger
// sessions (and with them the dark mode) stay attached.
// ---------------------------------------------------------------------------
const SETTINGS_HOST = "io.github.twinechat.twine";
const APPEARANCES = { system: "Follow System", light: "Light", dark: "Dark" };
const MENU_PREFIX = "twine-appearance-";

let settingsPort = null;
let appearance = { appearance: "system", systemDark: false };
const attachedTabs = new Set();

const wantDark = () =>
  appearance.appearance === "dark" ||
  (appearance.appearance === "system" && appearance.systemDark);

async function applyToTab(tabId) {
  try {
    if (!attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, "1.3");
      attachedTabs.add(tabId);
      // Needed for Page.javascriptDialogOpening (see below).
      await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    }
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setAutoDarkModeOverride", {
      enabled: wantDark(),
    });
  } catch {
    // Pages the debugger can't attach to (such as the file:// splash page).
  }
}

async function applyToAllTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => applyToTab(tab.id)));
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.url) applyToTab(tabId);
});
chrome.tabs.onCreated.addListener((tab) => applyToTab(tab.id));
chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));
chrome.debugger.onDetach.addListener((source) => attachedTabs.delete(source.tabId));

// LINE's page always registers a beforeunload handler that cancels closing
// (its message is empty and nothing ever sets it), so Chromium asks "Leave
// site?" every time the window is closed. Accept only that confirmation, so
// closing Twine works like closing any other app. Other dialogs are left alone.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Page.javascriptDialogOpening" || params.type !== "beforeunload") return;
  chrome.debugger
    .sendCommand(source, "Page.handleJavaScriptDialog", { accept: true })
    .catch(() => {});
});

function setUpAppearanceMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "twine-appearance", title: "Appearance", contexts: ["all"] });
    for (const [value, title] of Object.entries(APPEARANCES)) {
      chrome.contextMenus.create({
        id: MENU_PREFIX + value,
        parentId: "twine-appearance",
        title,
        type: "radio",
        checked: value === appearance.appearance,
        contexts: ["all"],
      });
    }
  });
}

function connectSettings() {
  settingsPort = chrome.runtime.connectNative(SETTINGS_HOST);
  settingsPort.onMessage.addListener((msg) => {
    if (!msg || !(msg.appearance in APPEARANCES)) return;
    const menuChanged = msg.appearance !== appearance.appearance;
    appearance = msg;
    if (menuChanged) {
      chrome.contextMenus.update(MENU_PREFIX + msg.appearance, { checked: true }, () => void chrome.runtime.lastError);
    }
    applyToAllTabs();
  });
  settingsPort.onDisconnect.addListener(() => {
    console.warn("Twine: settings helper disconnected", chrome.runtime.lastError?.message);
    settingsPort = null;
    setTimeout(connectSettings, 2000);
  });
}

// Saving goes through the helper, which writes the setting and then reports
// the new state back, which applies it.
chrome.contextMenus.onClicked.addListener((info) => {
  const id = String(info.menuItemId);
  if (!id.startsWith(MENU_PREFIX) || !settingsPort) return;
  settingsPort.postMessage({ command: "set", appearance: id.slice(MENU_PREFIX.length) });
});

setUpAppearanceMenu();
connectSettings();

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
