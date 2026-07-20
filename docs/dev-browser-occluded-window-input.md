# Occluded connected-Chrome windows silently drop trusted input

Verified live on Windows 11, Chrome 150, 2026-07-20, against a real user-profile
Chrome connected over CDP (`--connect http://127.0.0.1:9223`).

## Symptom

When the driven Chrome window is **fully covered by other windows** and is not
the foreground window, Windows' native occlusion tracking makes Chrome freeze
the tab's renderer:

- Reads keep working: `observe`, `find`, `text`, `navigate`, `evaluate` all
  succeed, because the renderer's main thread still runs JavaScript.
- Trusted input dies: `Input.dispatchMouseEvent` / key events are silently
  dropped (a click "succeeds" but nothing happens) or the action times out on
  its wait condition. Every element in a batch fails identically, which
  masquerades as a broken site, changed selectors, or an account block.

The window does not need to be minimized — full coverage by normal windows is
enough. Because reads still work, the failure is extremely misleading.

## Detection

`document.visibilityState` is **not reliable** on Windows: it can stay
`"visible"` for minutes after coverage (and even after minimizing) because the
foreground window is never marked occluded and state propagation lags. The
reliable signal is frame production: `requestAnimationFrame` stops firing in a
frozen renderer while `evaluate` still returns. The daemon probes exactly that
(`rendererProducingFrames` in `daemon/src/window-visibility.ts`) before every
trusted-input action on connected browsers.

## What does NOT wake a fully covered window (all verified ineffective)

- `Page.bringToFront` / `Target.activateTarget` (tab-level only)
- `Browser.setWindowBounds` size nudges (window stays covered, re-occludes instantly)
- `Page.startScreencast` (produces zero frames on an occluded window)
- Raising the window from another process (`SetWindowPos HWND_TOP` is ignored
  for background processes)
- Hide/show cycles (`SW_HIDE` → `SW_SHOWNA`) — occlusion recomputes immediately
- Restore without activation (`SW_SHOWNOACTIVATE`) — window stays under its coverers

## What works

1. **Permanent fix (recommended):** launch the connected Chrome with
   `--disable-backgrounding-occluded-windows`. Playwright passes this flag to
   every browser it launches itself, which is why only `--connect` browsers are
   affected.
2. **Runtime remediation (what the daemon does):** CDP
   `Browser.setWindowBounds` minimize → normal. Chrome restores its own window,
   which Windows allows to raise and focus; the window physically stops being
   occluded and the renderer wakes. On Windows the daemon then immediately
   hands focus back to the previously foreground window (transient ALT keypress
   + `SetForegroundWindow`), so a user typing on the machine loses focus for
   well under a second. Input stays deliverable for a grace period even if the
   window gets covered again seconds later; the pre-action probe re-remediates
   whenever the freeze returns.

If every strategy fails, actions raise `WINDOW_OCCLUDED` (runtime family, exit
status 6) with the flag recommendation, instead of a generic timeout.

## Occlusion mechanics worth remembering

- A window is only occlusion-frozen when it is fully covered **and** not the
  foreground window. The foreground window is never occluded, whatever covers it.
- After a wake-up, re-freezing takes roughly 30–60 seconds once the window is
  both covered and background again.
- Windows excludes tool windows (`WS_EX_TOOLWINDOW`) from acting as occluders.
