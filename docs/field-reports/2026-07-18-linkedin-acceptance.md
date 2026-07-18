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

## Re-run after the four follow-up fixes (same day, commits 35cabae..ee237f3)

| Check | Verdict | Evidence |
|---|---|---|
| `--connect http://127.0.0.1:9223` | **FIXED** | `pages` answers in 480 ms, bounded by `--timeout` (previously hung 10+ min). |
| `find --within` scoped collection | **FIXED** | `find --name Milka --name-mode contains --within main` → 2 matches (row div + options button); previously 0 everywhere. |
| Scroll-container refs | **FIXED** | The conversation list `ul` and the thread panel now carry refs and a scrollable flag. |
| Virtualized enumeration (T2 full) | **PASS** | `find --scroll-container R403 --max-steps 8` on the live list: 7 steps, positions 227→3169 then stable, `uniqueItems: 34` (≥ 20), `exhausted: true`, no click. |
| Ref-based `click` / `type` | **STILL BLOCKED — new gate** | Ref revalidation now succeeds (no more STALE_REF), but every ref-based action fails with "Target bounding box did not stabilize within the bounded interval" (exit 3) — on list rows AND the stationary composer. Live LinkedIn never stops micro-animating, so the pre-action stability check never converges. Workaround: `click --xy` + ref-less `type`. Filed as follow-up (bound the gate with a jitter epsilon / animation suppression, same class of fix as bounded screenshots). |

## Authorized real-account sends (T6, T7) — 2026-07-18, explicit per-target user consent

| Test | Verdict | Evidence |
|---|---|---|
| T6 répondre à une conversation (cible: Djoko Christian, autorisée) | **PASS** | New-message compose: recipient combobox typed "Djoko", suggestion "Djoko Christian • CEO chez DNA Trading Company" selected (chip "Supprimer Djoko Christian" present), `assert --within main --text "Djoko Christian"` passed, message typed, send button enabled, clicked. `text --within main` after send confirmed the message under "Vous :" in the thread. No wrong-thread send. |
| T7 invitation de connexion avec note (cible: /in/kelly-ketchang-zintchem, note autorisée) | **PASS** | Se connecter → Ajouter une note → note field typed the exact 239-char authorized note (counter 239/300, Envoyer enabled) → Envoyer. Verified in invitation-manager/sent: "Kelly Ketchang Zintchem … Envoyé aujourd'hui" with the note text. |
| T9 quota d'invitations | **SKIPPED** (user declined — real-account risk) | Not run. |

Coordinate lesson: modal/eyeballed clicks must convert screenshot pixels → CSS px (this session DPR 1.25 → multiply by 0.8). `observe`-derived boxes are already CSS px and need no conversion. Mixing the two silently mis-clicked the invitation modal (closed it) until corrected.

Incidental observation (not caused by automation): LinkedIn showed a red account banner "Un problème est survenu lors du traitement de votre paiement — mettez à jour vos modes de paiement" (Premium billing issue on the user's account).

## Session hygiene

Search input cleared (verified ""), composer cleared (placeholder restored, send button gone),
no navigation left open beyond the Diane thread, no message/invitation sent.
