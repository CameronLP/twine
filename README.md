# Twine

*Chat on LINE from your GNOME desktop.*

Twine is an unofficial Flatpak app that runs the official
[LINE Chrome extension](https://chromewebstore.google.com/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc)
in its own desktop window. It works like a normal GNOME app, with its own
launcher entry, icon, dock grouping, Adwaita-styled window controls and
desktop notifications.

> This project is not affiliated with or endorsed by LY Corporation. "LINE"
> and the LINE logo are trademarks of LY Corporation. This repository has no
> LINE code or assets. The extension is downloaded from Google's Chrome Web
> Store update service when you build the app.

## How it works

The LINE extension is a Manifest V3 extension. It uses a module service
worker and the `downloads`, `notifications`, `system.display` and `cookies`
APIs, plus sandboxed pages. Electron and WebKitGTK don't implement those
APIs, so the app bundles a real Chromium:

| Piece | What it is |
| --- | --- |
| Runtime | `org.gnome.Platform` 51 |
| Base | `org.electronjs.Electron2.BaseApp` 26.08, which provides [zypak](https://github.com/refi64/zypak) so Chromium's sandbox works inside Flatpak |
| Browser | An unbranded Chromium snapshot build, pinned by revision and sha256. Branded Google Chrome ignores `--load-extension` since v137, but Chromium still supports it. |
| Extension | The `.crx` from the Web Store, pinned by sha256 and unpacked by `tools/crx_unpack.py` |

`tools/crx_unpack.py` reads the developer public key from the CRX3 header and
writes it into `manifest.json` as `"key"`. The unpacked extension therefore
keeps its official ID (`ophjlpahpchlmihnnnihgmmeilfjmjjc`), so its
`chrome-extension://` origin is the one LINE's servers expect. The script also
removes `update_url` so the pinned copy never auto-updates.

### Opening the window

Passing `--app=chrome-extension://…/index.html` to Chromium doesn't work
reliably. Chromium loads command-line extensions asynchronously, so the window
can open before the extension is ready, and the page fails with
`ERR_BLOCKED_BY_CLIENT`. Twine lets the extension open its own window instead:

- `data/twine.sh` starts Chromium with `--no-startup-window`.
- The build points the extension's manifest at Twine's bootstrap service worker
  (`data/bootstrap/twine-bg.js`), which imports LINE's own `background.js`.
  `twine-hook.js` captures LINE's toolbar-button handler, and the bootstrap
  calls it once per browser session. LINE's own code then opens the window
  and keeps track of it, as if you had clicked the extension button in Chrome.
- If Twine is already running, the launcher detects this through Chromium's
  singleton socket, not the lock file, which can be left behind after a crash.
  It then opens `twine-activate.html`, which asks the bootstrap to focus the
  LINE window and closes itself.

### Looking at home on GNOME

- **Window frame**: before each start, `data/twine-prefs.py` turns on
  Chromium's GTK theme in the profile. Chromium then draws the title bar and
  window buttons with the system GTK theme (Adwaita) and follows the system
  light or dark style.
- **Dock and icon**: the launcher passes `--class=io.github.twinechat.Twine`,
  which sets the X11 WM_CLASS and the Wayland app_id. GNOME then matches the
  window to the `.desktop` file and its icon.
- **Icon**: `data/io.github.twinechat.Twine.svg` is an original Adwaita-style
  icon, a green speech bubble with a loop of twine.
- **Profile**: Chromium uses a private profile in
  `~/.var/app/io.github.twinechat.Twine/config/chromium`.

## Building

Requirements: `flatpak`, `flatpak-builder` and the Flathub remote.

```sh
flatpak install flathub org.gnome.Platform//51 org.gnome.Sdk//51 \
    org.electronjs.Electron2.BaseApp//26.08

flatpak-builder --force-clean --user --install --repo=repo \
    build io.github.twinechat.Twine.yml
```

Then launch **Twine** from the GNOME app grid, or run:

```sh
flatpak run io.github.twinechat.Twine
```

Log in with your email and password or with the QR code. LINE may ask you to
confirm the login on your phone the first time.

### Making a bundle file

```sh
flatpak build-bundle repo twine.flatpak io.github.twinechat.Twine
flatpak install --user twine.flatpak
```

## Updating LINE or Chromium

The extension and Chromium are both pinned by sha256. When LINE publishes a new
extension version, the download no longer matches the pinned hash and the build
fails. To re-pin and rebuild, run:

```sh
tools/update-sources.sh            # both
tools/update-sources.sh extension  # just LINE
tools/update-sources.sh chromium   # just Chromium (nearest snapshot to Stable)
flatpak-builder --force-clean --user --install --repo=repo build io.github.twinechat.Twine.yml
```

When you update, also add a `<release>` entry to
`data/io.github.twinechat.Twine.metainfo.xml`.

## Permissions

| Permission | Why |
| --- | --- |
| `--share=network` | Talking to LINE's servers |
| `--socket=wayland`, `--socket=fallback-x11`, `--device=dri`, `--share=ipc` | Display and GPU acceleration |
| `--socket=pulseaudio` | Notification sounds and voice messages |
| `--talk-name=org.freedesktop.Notifications` | Desktop notifications for new messages |
| `--filesystem=xdg-download` | Saving received files and images |

## Troubleshooting

- **Debugging the extension**: run
  `flatpak run io.github.twinechat.Twine --remote-debugging-port=9222`, then open
  `chrome://inspect` in any Chromium-based browser. The launcher passes any
  extra arguments through to Chromium.
- **Forcing X11**: run `flatpak run io.github.twinechat.Twine --ozone-platform=x11`.
- **Resetting all data and logging out**: run
  `rm -rf ~/.var/app/io.github.twinechat.Twine`.
- **A stray "blocked" window after a crash**: close it. The main LINE window
  opens anyway.
- **"`--ozone-platform=wayland` is not compatible with Vulkan" in the log**: this
  message is harmless.

## Layout

```
io.github.twinechat.Twine.yml      Flatpak manifest
data/twine.sh                      Launcher (installed as /app/bin/twine)
data/twine-prefs.py                Turns on the GTK theme in the Chromium profile
data/bootstrap/                    Files added to the extension: bootstrap worker
                                   and the twine-activate.html focus page
data/*.desktop, *.metainfo.xml     Desktop entry and AppStream metadata
data/*.svg                         App icon
tools/crx_unpack.py                CRX3 to unpacked extension, keeping the store ID
tools/update-sources.sh            Re-pins the extension and Chromium hashes
```

## License

The wrapper code in this repository is under the MIT license (see `LICENSE`).
LINE and Chromium have their own licenses.
