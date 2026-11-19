// Twine: keep the window title as "Twine" instead of LINE's page title. LINE
// changes the title itself (for example with unread counts), so watch for
// changes and keep any count: "(3) LINE" becomes "(3) Twine".
const brand = () => {
  const title = document.title;
  const branded = /\bLINE\b/.test(title) ? title.replace(/\bLINE\b/g, "Twine") : (title.trim() ? title : "Twine");
  if (branded !== title) document.title = branded;
};
new MutationObserver(brand).observe(document.head, { subtree: true, childList: true, characterData: true });
brand();
