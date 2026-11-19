// Opened by the launcher when Twine is already running. Asks the background
// worker to focus the LINE window ("#quit": close all windows so Twine can
// restart with new settings). The worker then closes this helper window.
const message = location.hash === "#quit" ? "twine:quit" : "twine:activate";
chrome.runtime.sendMessage(message).catch(() => window.close());
