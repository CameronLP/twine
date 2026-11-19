// Twine: capture LINE's toolbar-button handler so Twine can open the LINE
// window itself. This module is imported before LINE's background.js, so the
// wrapper is in place when LINE registers its listener.
const handlers = [];
const onClicked = chrome.action.onClicked;
const addListener = onClicked.addListener.bind(onClicked);
onClicked.addListener = (fn) => {
  handlers.push(fn);
  return addListener(fn);
};

// Runs LINE's own "open or focus the main window" logic.
export function openMainWindow() {
  for (const fn of handlers) {
    Promise.resolve(fn()).catch((e) => console.warn("Twine: open failed", e));
  }
}
