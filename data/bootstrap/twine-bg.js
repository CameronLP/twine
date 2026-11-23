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
  enforceMinimumSize();
}

// Focus the LINE window, or reopen it if it's gone. If it was hidden (see
// "Running in the background"), show it first.
async function focusMainWindow() {
  const id = await getMainWindow();
  if (id !== null) {
    try {
      await chrome.windows.get(id); // Throws if the window is gone.
      if (await isWindowHidden()) await showMainWindow();
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
//   twine:background:<on|off>  the ☰ menu changed "Run in Background"
//   twine:autostart:<on|off>   the ☰ menu changed "Start at Login"
//   twine:quit              the ☰ menu's Quit, or Ctrl+Q (twine-menu.js)
//   twine:shortcuts         Keyboard Shortcuts, or Ctrl+? (twine-menu.js)
//   twine:about             About Twine (twine-menu.js)
chrome.runtime.onMessage.addListener((msg, sender) => {
  // LINE's notifications, from twine-notifications.js (see "Notifications").
  if (msg?.twineNotification) {
    settingsPort?.postMessage({ command: "notify", ...msg.twineNotification });
    return;
  }
  if (msg?.twineWithdrawNotification) {
    settingsPort?.postMessage({ command: "withdraw-notification", id: msg.twineWithdrawNotification });
    return;
  }
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
  } else if (kind === "background") {
    setBackground(value === "on");
  } else if (kind === "autostart") {
    setAutostart(value === "on");
  } else if (kind === "quit") {
    quit();
  } else if (kind === "shortcuts" || kind === "about") {
    showDialog(kind);
  }
});

// Minimum window size. LINE's page needs at least 680x490 (with
// twine-layout.js) at 100% zoom, and proportionally more when zoomed in; a
// smaller window gets scroll bars on both sides of the whole page. The minimum
// is never larger than the screen's work area, so a big zoom level can't ask
// for a window that doesn't fit.
//
// On X11, the settings helper (twine-settings-host) sets this minimum on the
// window, and the window manager enforces it while you resize. Under
// --ozone-platform=wayland that isn't possible, so once a resize ends below the
// minimum, the window is grown back. The debounce waits until the resize is
// finished, so the worker doesn't fight the compositor mid-drag. After zooming
// in, a window that is now too small is grown the same way.
const MIN_WIDTH = 680;
const MIN_HEIGHT = 490;
let pageZoom = 1; // LINE's zoom level. Chromium zooms per origin, so all of LINE's windows share it.
let minSizeTimer = null;

async function minimumSize(win) {
  let width = Math.round(MIN_WIDTH * pageZoom);
  let height = Math.round(MIN_HEIGHT * pageZoom);
  try {
    // The display that holds the middle of the window, or the primary one.
    const displays = await chrome.system.display.getInfo();
    const x = win.left + win.width / 2;
    const y = win.top + win.height / 2;
    const display =
      displays.find(({ bounds: b }) => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height) ??
      displays.find((d) => d.isPrimary) ??
      displays[0];
    if (display) {
      width = Math.min(width, display.workArea.width);
      height = Math.min(height, display.workArea.height);
      return { width, height, workArea: display.workArea };
    }
  } catch {
    // Without display information, don't limit the minimum.
  }
  return { width, height };
}

async function enforceMinimumSize() {
  const id = await getMainWindow();
  if (id === null) return;
  let win;
  try {
    win = await chrome.windows.get(id);
  } catch {
    return; // The window was closed.
  }
  const min = await minimumSize(win);
  settingsPort?.postMessage({ command: "min-size", width: min.width, height: min.height });
  if (win.state !== "normal") return; // Maximized, fullscreen, minimized.
  if (win.width >= min.width && win.height >= min.height) return;
  chrome.windows
    .update(id, { width: Math.max(win.width, min.width), height: Math.max(win.height, min.height) })
    .catch(() => {});
}

chrome.windows.onBoundsChanged.addListener(() => {
  clearTimeout(minSizeTimer);
  minSizeTimer = setTimeout(enforceMinimumSize, 400);
});

// LINE's popup windows (photo viewer, popped-out chats).
//
// LINE opens each at the size it saved for that kind of popup, then corrects
// the size with resizeBy(wanted - measured). Under Twine, that correction runs
// before the window is on screen, when Chromium reports its outer size as 0x0
// (and before the zoom level applies), so the window collapses to Chromium's
// smallest size, 100x100, and LINE then saves that size. So: remember the
// size each popup was created with (the size LINE asked for), and if it
// collapses within its first seconds, put that size back right away.
//
// As a safety net, once a popup has loaded, check for a few seconds whether
// its content overflows the window (the same test that decides on scroll bars)
// and enlarge the window to fit, up to the screen's work area. Neither
// depends on how LINE builds its popups. Popups can still be made smaller by
// hand.
const newPopups = new Map(); // windowId -> { width, height, time }

chrome.windows.onCreated.addListener((win) => {
  if (win.type === "popup") newPopups.set(win.id, { width: win.width, height: win.height, time: Date.now() });
});
chrome.windows.onRemoved.addListener((windowId) => newPopups.delete(windowId));
chrome.windows.onBoundsChanged.addListener((win) => {
  const created = newPopups.get(win.id);
  if (!created) return;
  if (Date.now() - created.time > 5000) {
    newPopups.delete(win.id);
    return;
  }
  const collapsed = win.width < created.width / 2 && win.height < created.height / 2;
  if (collapsed && win.state === "normal") {
    chrome.windows.update(win.id, { width: created.width, height: created.height }).catch(() => {});
  }
});
async function fitPopup(windowId, tabId) {
  const zoomFactor = await chrome.tabs.getZoom(tabId).catch(() => 1);
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    let size;
    try {
      await applyToTab(tabId); // Makes sure the debugger is attached.
      const { result } = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        // The page or its body scrolls, depending on the popup.
        expression: `(() => {
          const d = document.documentElement, b = document.body || d;
          return { sw: Math.max(d.scrollWidth, b.scrollWidth + (innerWidth - b.clientWidth)),
                   sh: Math.max(d.scrollHeight, b.scrollHeight + (innerHeight - b.clientHeight)),
                   iw: innerWidth, ih: innerHeight };
        })()`,
        returnByValue: true,
      });
      size = result.value;
    } catch {
      return; // The popup was closed.
    }
    const extraWidth = Math.max(0, size.sw - size.iw);
    const extraHeight = Math.max(0, size.sh - size.ih);
    if (!extraWidth && !extraHeight) continue;
    try {
      const win = await chrome.windows.get(windowId);
      if (win.state !== "normal") return;
      const { width: maxWidth, height: maxHeight } = (await minimumSize(win)).workArea ?? {};
      const width = win.width + Math.ceil(extraWidth * zoomFactor);
      const height = win.height + Math.ceil(extraHeight * zoomFactor);
      await chrome.windows.update(windowId, {
        width: maxWidth ? Math.min(width, maxWidth) : width,
        height: maxHeight ? Math.min(height, maxHeight) : height,
      });
    } catch {
      return;
    }
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status !== "complete" || tab.windowId === (await getMainWindow())) return;
  if (!(tab.url || "").startsWith(chrome.runtime.getURL(""))) return; // LINE's own pages only
  if ((tab.url || "").includes("twine-activate.html")) return;
  try {
    if ((await chrome.windows.get(tab.windowId)).type !== "popup") return;
  } catch {
    return;
  }
  fitPopup(tab.windowId, tabId);
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

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "loading" || change.url) applyToTab(tabId);
  if (change.status === "complete" && (tab.url || "").startsWith(MAIN_URL)) markPageUsed(tabId);
});

// Chromium only asks "Leave site?" (see below) if the page has been used: you
// have clicked or typed in it since it loaded. Without the question, closing
// the window right after starting Twine would quit it even with "Run in
// Background" on. So once LINE's page has loaded, mark it as used, by running
// an empty script as if from a click (Runtime.evaluate with userGesture).
async function markPageUsed(tabId) {
  await applyToTab(tabId); // Makes sure the debugger is attached.
  chrome.debugger
    .sendCommand({ tabId }, "Runtime.evaluate", { expression: "void 0", userGesture: true })
    .catch(() => {});
}
chrome.tabs.onCreated.addListener((tab) => applyToTab(tab.id));
chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));
chrome.debugger.onDetach.addListener((source) => attachedTabs.delete(source.tabId));

// LINE's page always registers a beforeunload handler that cancels closing
// (its message is empty and nothing ever sets it), so Chromium asks "Leave
// site?" every time the window is closed. Twine answers that question itself,
// so closing works like in any other app:
//
//   - With "Run in Background" on, closing the main window hides it instead,
//     and LINE keeps running (see "Running in the background" below).
//   - Otherwise, when quitting, for LINE's other windows, and when LINE
//     reloads or navigates its own page, the confirmation is accepted.
//
// Chromium asks the same question before a reload or navigation. Those are
// told apart by the navigation request Chromium reports just before asking.
// Other dialogs are left alone.
const recentNavigation = new Map(); // tabId -> time of its last navigation request

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (
    method === "Page.frameRequestedNavigation" ||
    method === "Page.frameStartedNavigating" ||
    method === "Page.frameScheduledNavigation"
  ) {
    recentNavigation.set(source.tabId, Date.now());
    return;
  }
  if (method !== "Page.javascriptDialogOpening" || params.type !== "beforeunload") return;
  const navigating = Date.now() - (recentNavigation.get(source.tabId) ?? 0) < 2000;
  let hide = false;
  if (!quitting && !navigating && runInBackground()) {
    try {
      const tab = await chrome.tabs.get(source.tabId);
      hide = tab.windowId === (await getMainWindow());
    } catch {
      // The tab is gone.
    }
  }
  await chrome.debugger
    .sendCommand(source, "Page.handleJavaScriptDialog", { accept: !hide })
    .catch(() => {});
  if (hide) hideMainWindow();
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
function zoomChanged(factor) {
  updateZoomMenu(factor);
  pageZoom = factor;
  enforceMinimumSize();
}
chrome.tabs.onZoomChange.addListener(({ newZoomFactor }) => zoomChanged(newZoomFactor));

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
    chrome.contextMenus.create({ id: "twine-separator-2", type: "separator", contexts: ["all"] });
    chrome.contextMenus.create({
      id: "twine-background",
      title: "Run in Background",
      type: "checkbox",
      checked: Boolean(appearance.background),
      enabled: Boolean(appearance.canHide),
      contexts: ["all"],
    });
    chrome.contextMenus.create({
      id: "twine-autostart",
      title: "Start at Login",
      type: "checkbox",
      checked: Boolean(appearance.autostart),
      contexts: ["all"],
    });
    chrome.contextMenus.create({ id: "twine-separator-3", type: "separator", contexts: ["all"] });
    chrome.contextMenus.create({ id: "twine-shortcuts", title: "Keyboard Shortcuts", contexts: ["all"] });
    chrome.contextMenus.create({ id: "twine-about", title: "About Twine", contexts: ["all"] });
    chrome.contextMenus.create({ id: "twine-quit", title: "Quit", contexts: ["all"] });
    chrome.tabs.query({}, (tabs) => {
      const tab = tabs.find((t) => (t.url || "").startsWith(MAIN_URL));
      if (tab) chrome.tabs.getZoom(tab.id, zoomChanged);
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
    if (msg?.event === "notification-clicked") {
      notificationClicked(msg.id);
      return;
    }
    if (msg?.event === "quit") {
      quit();
      return;
    }
    if (msg?.event === "activate") {
      // GNOME asked Twine to show itself (app grid, D-Bus activation).
      started.then(focusMainWindow);
      return;
    }
    if (!msg || !(msg.appearance in APPEARANCES)) return;
    const menuChanged = msg.appearance !== appearance.appearance;
    appearance = msg;
    if (menuChanged) {
      chrome.contextMenus.update(MENU_PREFIX + msg.appearance, { checked: true }, () => void chrome.runtime.lastError);
    }
    chrome.contextMenus.update(
      "twine-background",
      { checked: Boolean(msg.background), enabled: Boolean(msg.canHide) },
      () => void chrome.runtime.lastError,
    );
    chrome.contextMenus.update("twine-autostart", { checked: Boolean(msg.autostart) }, () => void chrome.runtime.lastError);
    startHiddenIfAsked();
    // The ☰ menu (twine-menu.js) watches these keys to show the current state.
    chrome.storage.session.set({
      twinePortalNotifications: Boolean(msg.portalNotifications),
      twineAppearance: msg.appearance,
      twineBackground: {
        enabled: Boolean(msg.background),
        available: Boolean(msg.canHide),
        allowed: msg.backgroundAllowed !== false,
      },
      twineAutostart: { enabled: Boolean(msg.autostart) },
    });
    applyToAllTabs();
  });
  // Tell the helper the current minimum window size.
  enforceMinimumSize();
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
  else if (id === "twine-background") setBackground(info.checked);
  else if (id === "twine-autostart") setAutostart(info.checked);
  else if (id === "twine-quit") quit();
  else if (id === "twine-shortcuts") showDialog("shortcuts");
  else if (id === "twine-about") showDialog("about");
});

// ---------------------------------------------------------------------------
// Running in the background.
//
// LINE's page, not its background script, keeps the connection and shows the
// notifications, so it has to stay open for messages to arrive. With "Run in
// Background" on (the default), closing the main window hides it instead
// (twine-settings-host withdraws it on X11), and GNOME lists Twine under
// Background Apps. Opening Twine again, or clicking a notification, shows the
// window. Quit (menus, Ctrl+Q, or Background Apps in Quick Settings) really
// quits.
//
// Hiding needs X11 (the default). Under --ozone-platform=wayland, and when
// GNOME's background permission is denied, closing quits as before.
// ---------------------------------------------------------------------------
let quitting = false;

// Whether the main window is hidden lives in chrome.storage.session
// (twineHidden), not in a variable: Chromium stops this worker when it's idle
// and starts it again on demand, which would reset a variable while the window
// stays hidden, and reopening Twine would then focus a window that isn't shown.
const isWindowHidden = async () =>
  Boolean((await chrome.storage.session.get("twineHidden")).twineHidden);

const runInBackground = () =>
  Boolean(appearance.background && appearance.canHide && appearance.backgroundAllowed !== false);

// Keyboard Shortcuts and About Twine: libadwaita's own dialogs, opened by the
// helper as GTK windows attached to Twine's window (twine-dialogs).
function showDialog(dialog) {
  settingsPort?.postMessage({
    command: "show-dialog",
    dialog,
    style: appearance.appearance === "system" ? "default" : appearance.appearance,
  });
}

function setBackground(enabled) {
  settingsPort?.postMessage({ command: "set-background", enabled: Boolean(enabled) });
}

// "Start at Login" (off by default). twine-settings-host asks GNOME, through
// the Background portal, to add or remove Twine from the login items. Started
// at login, the helper reports startHidden, and the window is hidden as soon
// as it can be, so Twine starts in Background Apps without opening a window.
// Without "Run in Background", it starts with its window, as usual.
function setAutostart(enabled) {
  settingsPort?.postMessage({ command: "set-autostart", enabled: Boolean(enabled) });
}

async function startHiddenIfAsked() {
  if (!appearance.startHidden || !runInBackground()) return;
  const { twineStartedHidden } = await chrome.storage.session.get("twineStartedHidden");
  if (twineStartedHidden) return; // Only once, at startup.
  await chrome.storage.session.set({ twineStartedHidden: true });
  await started;
  hideMainWindow();
}

// twineHidden in chrome.storage.session tells LINE's page (twine-notifications.js)
// that its window is hidden: Chromium doesn't notice, so the page still thinks
// it has focus.
async function hideMainWindow() {
  await chrome.storage.session.set({ twineHidden: true });
  settingsPort?.postMessage({ command: "hide" });
}

async function showMainWindow() {
  await chrome.storage.session.set({ twineHidden: false });
  settingsPort?.postMessage({ command: "show" });
  // Give the window manager a moment to map the window before focusing it.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

// Close every window, accepting LINE's "Leave site?" question; Chromium then
// exits. A hidden main window is shown first, so Chromium can close it
// normally.
async function quit() {
  quitting = true;
  if (await isWindowHidden()) await showMainWindow();
  const windows = await chrome.windows.getAll({ windowTypes: ["normal", "popup", "app"] });
  await Promise.all(windows.map((w) => chrome.windows.remove(w.id).catch(() => {})));
}

// LINE focuses its window when a notification is clicked, which doesn't show
// a hidden window. (For notifications Chromium still shows, when the portal
// isn't available.)
chrome.notifications.onClicked.addListener(() => focusMainWindow());

// ---------------------------------------------------------------------------
// Notifications. twine-notifications.js hands LINE's notifications to this
// worker, and twine-settings-host sends them through GNOME's notification
// portal (see twine-notifications.js for why). When one is clicked, the helper
// reports it: show the window, then let LINE's page run LINE's own click
// handler, which opens the chat.
// ---------------------------------------------------------------------------
let lastClick = { id: null, time: 0 };

async function notificationClicked(id) {
  // Some portal versions report a click twice (signal and activation).
  if (id === lastClick.id && Date.now() - lastClick.time < 2000) return;
  lastClick = { id, time: Date.now() };
  // When the click started Twine, wait until its window is set up.
  await started;
  await focusMainWindow();
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => (t.url || "").startsWith(MAIN_URL));
  if (tab) chrome.tabs.sendMessage(tab.id, `twine:notification-clicked:${id}`).catch(() => {});
}

// ---------------------------------------------------------------------------
// Downloads. Chromium's download bubble belongs to its toolbar, which Twine's
// window doesn't have, so it appeared partly off screen in the window's
// top-left corner. Turn Chromium's download UI off (this needs the
// downloads.ui permission, which the build adds) and have twine-settings-host
// say when a download has finished, with a GNOME notification that opens the
// file's folder.
// ---------------------------------------------------------------------------
chrome.downloads.setUiOptions({ enabled: false }).catch((e) =>
  console.error("Twine: can't turn off Chromium's download UI", e),
);

chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== "complete") return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item?.filename) return;
  settingsPort?.postMessage({ command: "notify-download", id: `twine-download-${item.id}`, path: item.filename });
});

setUpMenu();
connectSettings();

// Registering these listeners makes sure Chromium starts this worker at launch.
chrome.runtime.onStartup.addListener(() => {});
chrome.runtime.onInstalled.addListener(() => {});

// Adopt the splash window once per browser session. Session storage is cleared
// when Chromium exits, so later service-worker restarts don't run this again.
// Requests to show the window wait for this (started), so they can't open a
// second window while Twine is starting.
const started = (async () => {
  const { twineStarted } = await chrome.storage.session.get("twineStarted");
  if (twineStarted) return;
  await chrome.storage.session.set({ twineStarted: true });
  await adoptSplashWindow();
})().catch((e) => console.error("Twine: bootstrap failed", e));
