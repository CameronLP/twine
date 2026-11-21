// Twine: let LINE's layout fit narrower windows, so Twine can be snapped to
// half of the screen.
//
// LINE's main grid is a 62px navigation bar, a fixed 328px chat list and a
// conversation pane of at least 375px, and LINE sets a minimum size of 780x490
// on #root (an inline style). GNOME only offers half-screen snapping when the
// window's minimum width fits in half the screen, and on many screens that is
// less than 780px. So:
//
//   - the chat list stays 328px when there's room and shrinks down to 240px
//     in narrower windows, and
//   - #root's minimum width becomes 62 + 240 + 375 = 677px, which fits half
//     of a 1366px-wide screen.
//
// The selectors match LINE's CSS module names without the build hash, so they
// keep working across LINE updates. The minimum window size that
// twine-settings-host and twine-bg.js enforce (MIN_WIDTH) must stay in step
// with this.
const style = document.createElement("style");
style.textContent = `
  #root {
    min-width: 677px !important;
    min-height: 490px !important;
  }
  [class*="pageLayout-module__wrap__"] {
    grid-template-columns: 62px minmax(240px, 328px) minmax(375px, 1fr) !important;
  }
`;
document.head.append(style);
