// Twine: a ☰ menu in the top-right corner of LINE's window, with the
// appearance (Follow System / Light / Dark) and zoom controls that are also in
// the right-click menu.
//
// The window's title bar is drawn by GNOME's window manager, so Twine can't put
// buttons in it. The menu button sits in the empty right end of LINE's top row
// (the All / Friends / Groups tabs) instead.
//
// The menu lives in a shadow root, so LINE's styles and Twine's don't mix. It
// is styled for light mode only: in dark mode, Chromium's auto dark mode darkens
// it together with the rest of LINE's page.
//
// Changes go to Twine's bootstrap worker (twine-bg.js) as "twine:…" messages,
// which saves and applies them. The worker keeps the current appearance in
// chrome.storage.session, and Chromium reports zoom changes, so the menu also
// follows changes made from the right-click menu or with Ctrl +/-/0.
(() => {
  const APPEARANCES = [
    ["system", "Follow System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];

  const ICONS = {
    menu: '<path d="M3 4.5h14M3 10h14M3 15.5h14"/>',
    system: '<circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 0 1 0 14z" fill="currentColor"/>',
    light:
      '<circle cx="10" cy="10" r="3.5"/><path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6 16 16M4 16l1.4-1.4M14.6 5.4 16 4"/>',
    dark: '<path d="M16.5 12.5A7 7 0 0 1 7.5 3.5a7 7 0 1 0 9 9z"/>',
    minus: '<path d="M5 10h10"/>',
    plus: '<path d="M5 10h10M10 5v10"/>',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font: inherit; }
    .wrap {
      position: fixed; top: 9px; right: 12px; z-index: 2147483000;
      font: 14px/1.4 "Adwaita Sans", Cantarell, system-ui, sans-serif; color: #1e1e1e;
    }
    button {
      border: 0; margin: 0; background: transparent; color: inherit; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
    }
    button:focus-visible { outline: 2px solid #3584e4; outline-offset: 1px; }
    .toggle { width: 34px; height: 34px; border-radius: 8px; color: #555; }
    .toggle:hover, .toggle[aria-expanded="true"] { background: rgba(0, 0, 0, 0.08); color: #1e1e1e; }
    .popover {
      position: absolute; top: 40px; right: 0; width: 236px; padding: 12px;
      background: #fff; border-radius: 12px;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06), 0 6px 20px rgba(0, 0, 0, 0.18);
    }
    .popover[hidden] { display: none; }
    .label { font-size: 12px; font-weight: 600; color: #6b6b6b; margin: 0 2px 6px; }
    .row { display: flex; gap: 4px; }
    .row + .label { margin-top: 12px; }
    .row button { flex: 1; height: 34px; border-radius: 8px; background: rgba(0, 0, 0, 0.05); }
    .row button:hover { background: rgba(0, 0, 0, 0.1); }
    .row button[aria-pressed="true"] { background: #06c755; color: #fff; }
    .row .percent { flex: 1.6; font-variant-numeric: tabular-nums; }
    .row button:disabled { opacity: 0.4; cursor: default; }
  `;

  function build() {
    const host = document.createElement("div");
    host.id = "twine-menu";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrap">
        <button class="toggle" aria-label="Twine menu" title="Twine menu"
          aria-haspopup="true" aria-expanded="false">${icon("menu")}</button>
        <div class="popover" role="dialog" aria-label="Twine menu" hidden>
          <div class="label">Appearance</div>
          <div class="row appearance">
            ${APPEARANCES.map(([value, title]) =>
              `<button data-appearance="${value}" title="${title}" aria-label="${title}"
                aria-pressed="false">${icon(value)}</button>`).join("")}
          </div>
          <div class="label">Zoom</div>
          <div class="row">
            <button data-zoom="out" title="Zoom Out (Ctrl+−)" aria-label="Zoom Out">${icon("minus")}</button>
            <button data-zoom="reset" class="percent" title="Reset Zoom (Ctrl+0)" aria-label="Reset Zoom">100%</button>
            <button data-zoom="in" title="Zoom In (Ctrl++)" aria-label="Zoom In">${icon("plus")}</button>
          </div>
        </div>
      </div>`;

    const toggle = root.querySelector(".toggle");
    const popover = root.querySelector(".popover");
    const percent = root.querySelector(".percent");

    const setOpen = (open) => {
      popover.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    };
    toggle.addEventListener("click", () => setOpen(popover.hidden));
    // Close when clicking anywhere else or pressing Escape.
    document.addEventListener("pointerdown", (e) => {
      if (!e.composedPath().includes(host)) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !popover.hidden) {
        setOpen(false);
        toggle.focus();
      }
    });

    root.querySelectorAll("[data-appearance]").forEach((button) =>
      button.addEventListener("click", () =>
        chrome.runtime.sendMessage(`twine:appearance:${button.dataset.appearance}`).catch(() => {}))
    );
    root.querySelectorAll("[data-zoom]").forEach((button) =>
      button.addEventListener("click", () =>
        chrome.runtime.sendMessage(`twine:zoom:${button.dataset.zoom}`).catch(() => {}))
    );

    // Keep the menu in step with the saved appearance and the zoom level.
    const showAppearance = (value) =>
      root.querySelectorAll("[data-appearance]").forEach((button) =>
        button.setAttribute("aria-pressed", String(button.dataset.appearance === value)));
    chrome.storage.session.get("twineAppearance", ({ twineAppearance }) =>
      showAppearance(twineAppearance ?? "system"));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "session" && changes.twineAppearance) showAppearance(changes.twineAppearance.newValue);
    });

    const showZoom = (factor) => {
      const value = Math.round(factor * 100);
      percent.textContent = `${value}%`;
      percent.disabled = value === 100;
    };
    chrome.tabs.getCurrent((tab) => {
      if (!tab) return;
      chrome.tabs.getZoom(tab.id, showZoom);
      chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => {
        if (tabId === tab.id) showZoom(newZoomFactor);
      });
    });

    document.body.append(host);
  }

  // This script runs from <head>, before LINE's page has a <body>.
  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build, { once: true });
})();
