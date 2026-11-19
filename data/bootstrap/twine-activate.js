// Opened by the launcher when Twine is already running. Asks the background
// worker to focus the LINE window; the worker then closes this helper window.
chrome.runtime.sendMessage("twine:activate").catch(() => window.close());
