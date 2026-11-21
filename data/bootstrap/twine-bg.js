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

// Messages from Twine's own pages. Each is a string starting with "twine:", so
// LINE's background.js, which listens too, ignores them.
//   twine:activate          a second launch of Twine (twine-activate.html)
//   twine:appearance:<v>    the ☰ menu (twine-menu.js) picked an appearance
//   twine:zoom:<in|out|reset>  the ☰ menu changed the zoom
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (typeof msg !== "string" || !msg.startsWith("twine:")) return;
  const [, kind, value] = msg.split(":");
  if (kind === "activate") {
    focusMainWindow().finally(() => {
      if (sender.tab) chrome.windows.remove(sender.tab.windowId).catch(() => {});
    });
  } else if (kind === "appearance") {
    setAppearance(value);
  } else if (kind === "zoom" && sender.tab) {
    zoom(sender.tab.id, value);
  }
});

// Fallback minimum window size. LINE's page needs at least 680x490 (with
// twine-layout.js), so a smaller window gets scroll bars on both sides of the
// whole page (see twine-settings-host). On X11, the
// settings helper (twine-settings-host) sets a real minimum size that the
// window manager enforces while resizing, so this never triggers there. Under
// --ozone-platform=wayland that isn't possible, so once a resize ends below the
// minimum, grow the window back. The debounce waits until the resize is
// finished, so the worker doesn't fight the compositor mid-drag.
const MIN_WIDTH = 680;
const MIN_HEIGHT = 490;
let minSizeTimer = null;

chrome.windows.onBoundsChanged.addListener((win) => {
  clearTimeout(minSizeTimer);
  minSizeTimer = setTimeout(async () => {
    if (win.id !== (await getMainWindow())) return;
    let current;
    try {
      current = await chrome.windows.get(win.id);
    } catch {
      return; // The window was closed.
    }
    if (current.state !== "normal") return; // Maximized, fullscreen, minimized.
    if (current.width >= MIN_WIDTH && current.height >= MIN_HEIGHT) return;
    chrome.windows
      .update(win.id, {
        width: Math.max(current.width, MIN_WIDTH),
        height: Math.max(current.height, MIN_HEIGHT),
      })
      .catch(() => {});
  }, 400);
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

// ---------------------------------------------------------------------------
// Zoom. Chromium's page zoom (Ctrl +/-/0) already works in Twine's window; these
// are the same steps for the right-click menu and the ☰ menu. Chromium saves
// the zoom level in the profile, so it's kept across restarts.
// ---------------------------------------------------------------------------
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

async function zoom(tabId, direction) {
  try {
    if (direction === "reset") {
      await chrome.tabs.setZoom(tabId, 0); // 0 means the default zoom.
      return;
    }
    const current = await chrome.tabs.getZoom(tabId);
    const next =
      direction === "in"
        ? ZOOM_STEPS.find((z) => z > current + 0.001)
        : ZOOM_STEPS.findLast((z) => z < current - 0.001);
    if (next) await chrome.tabs.setZoom(tabId, next);
  } catch {
    // The tab is gone or can't be zoomed.
  }
}

// Show the current zoom in the right-click menu's reset item.
function updateZoomMenu(factor) {
  const percent = Math.round(factor * 100);
  chrome.contextMenus.update(
    "twine-zoom-reset",
    { title: percent === 100 ? "Reset Zoom" : `Reset Zoom (${percent}%)`, enabled: percent !== 100 },
    () => void chrome.runtime.lastError,
  );
}
chrome.tabs.onZoomChange.addListener(({ newZoomFactor }) => updateZoomMenu(newZoomFactor));

function setUpMenu() {
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
    chrome.contextMenus.create({ id: "twine-separator", type: "separator", contexts: ["all"] });
    chrome.contextMenus.create({ id: "twine-zoom-in", title: "Zoom In", contexts: ["all"] });
    chrome.contextMenus.create({ id: "twine-zoom-out", title: "Zoom Out", contexts: ["all"] });
    chrome.contextMenus.create({ id: "twine-zoom-reset", title: "Reset Zoom", contexts: ["all"] });
    chrome.tabs.query({}, (tabs) => {
      const tab = tabs.find((t) => (t.url || "").startsWith(MAIN_URL));
      if (tab) chrome.tabs.getZoom(tab.id, updateZoomMenu);
    });
  });
}

// Saving goes through the helper, which writes the setting and then reports
// the new state back, which applies it.
function setAppearance(value) {
  if (value in APPEARANCES && settingsPort) {
    settingsPort.postMessage({ command: "set", appearance: value });
  }
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
    // The ☰ menu (twine-menu.js) watches this key to show the current choice.
    chrome.storage.session.set({ twineAppearance: msg.appearance });
    applyToAllTabs();
  });
  settingsPort.onDisconnect.addListener(() => {
    console.warn("Twine: settings helper disconnected", chrome.runtime.lastError?.message);
    settingsPort = null;
    setTimeout(connectSettings, 2000);
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (id.startsWith(MENU_PREFIX)) setAppearance(id.slice(MENU_PREFIX.length));
  else if (id.startsWith("twine-zoom-") && tab) zoom(tab.id, id.slice("twine-zoom-".length));
});

setUpMenu();
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
