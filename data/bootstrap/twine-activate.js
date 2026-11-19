// Asks the background worker to focus (or reopen) the LINE window. The
// worker then closes this helper window.
chrome.runtime.sendMessage("twine:activate").catch(() => window.close());
