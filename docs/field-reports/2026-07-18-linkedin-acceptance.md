# Field acceptance run — LinkedIn automation session (2026-07-18)

Real-session acceptance of the T1–T5/T8 battery from the reliability handoff, against the user's
`automation-chrome` profile (CDP port 9223), Chrome 150, dev-browser post-PR#3 release binary.
Non-destructive scope only: no message or invitation sent; T6/T7/T9 not run.

## Results

| Test | Verdict | Evidence |
|---|---|---|
| T1 capture messagerie | **PASS** (with caveat) | 747 ms, `captureMode: cdp`, PNG 1920x912 valid. Caveat: capture hangs to deadline when the Chrome window is minimized (`fromSurface` produces no frame) — restoring the window fixes it. |
| T2 observe scopé | **PASS** (partial) | `observe --within main --max-nodes 300`: 131 elements, 14 named conversation rows, no budget wasted on chrome. ≥20-rows enumeration via container scroll BLOCKED (see gaps 1 and 3). |
| T3 ouvrir un fil nommé | **PASS** (via workaround) | Row located from scoped observe; ref-based click failed (gap 1); `click --xy` on the observed box worked; URL switched to the new `/messaging/thread/<id>`; header + thread content confirmed Diane COULIBALY. |
| T4 lire le fil entier | **PASS** | `text --within main`: 8 376 chars, bounded, messages fully attributed ("Caleb Russel a envoyé…", "Diane COULIBALY a envoyé…"), multiline preserved. |
| T5 rédiger sans envoyer | **PASS** (via workaround) | Ref-based `type` failed (gap 1); focus via `click --xy` + ref-less `type` (keyboard strategy) entered the exact 2-line accented text; send button flipped to enabled (`disabled: false` + visual). Composer then cleared; no send. |
| T8 envoi indisponible | **PASS** (behavioral) | With composer empty, LinkedIn removes the send button entirely → any action returns typed `TARGET_MISSING`/`TARGET_DISABLED`, never false success. `find --state disabled` blind due to gap 1. |

Safety nets observed working in production: `INPUT_VALUE_MISMATCH` correctly refused success when
multiline text was typed into the (wrong) search input; `STALE_REF` exits 3 typed; `assert --within`
works; window-scoped budgets honored.

## Product gaps discovered (filed as follow-up tasks)

1. **Action-time ref revalidation and `find` collect UNSCOPED perception with default budgets.**
   On a heavy page the collection never reaches mid-page elements, so refs produced by a scoped
   `observe --within` are systematically "stale or semantically changed" when used by `click`/`type`
   (even with `--from-state`), and `find` returns 0 matches for elements plainly present (even with
   `--scope document`). The scoped observe→act loop is unusable on real LinkedIn; local fixtures were
   small enough that unscoped revalidation still reached the targets. Fix direction: carry the scope
   into action-time revalidation (resolve refs against the same scoped collection that produced them),
   and scope find's collection when `--within` is given.
2. **`--connect http://…` hangs indefinitely** resolving the CDP endpoint against this Chrome; the
   exact `ws://…` endpoint from `/json/version` connects instantly. `--timeout` is not honored during
   endpoint resolution.
3. **No ref for scroll containers.** The virtualized conversation-list container is an unnamed div and
   never gets a ref, so `scroll --ref` / `find --scroll-container` cannot target it. Fix direction:
   assign refs to scrollable elements (overflow ≠ visible) or accept a `within`-style scope for the
   container.
4. **Minimized-window capture** (T1 caveat): consider `fromSurface: false` fallback or an explicit
   diagnostic ("window may be minimized") when CDP capture hits the deadline.

## Session hygiene

Search input cleared (verified ""), composer cleared (placeholder restored, send button gone),
no navigation left open beyond the Diane thread, no message/invitation sent.
