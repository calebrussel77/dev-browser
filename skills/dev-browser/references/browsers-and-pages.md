# Browsers and pages

How to choose the browser you drive, and how to work across the tabs inside it.

## Decision 1 — which browser to drive

This is the first and most consequential choice. Pick from the *task*, not by habit.

| You want... | Use | What you get |
| --- | --- | --- |
| The user's real Chrome, with their logins, cookies, and open tabs | `dev-browser --connect` | Attaches over CDP to a running Chrome. Shares the user's session. Multiple tabs, one profile (see below). |
| A specific CDP endpoint you were handed | `dev-browser --connect http://localhost:9222` (or a `ws://...` URL) | Same as above, but no auto-discovery. |
| A clean, isolated, *persistent* automation profile | `dev-browser --browser <task-name>` | A dedicated Chromium profile at `~/.dev-browser/<task-name>/chromium-profile`. Its own cookie jar and login state, kept between runs, isolated from every other name. |
| Disposable unattended automation | `dev-browser --browser <name> --headless` | A managed profile with no visible window. |

Key consequences to internalize:

- **`--connect` auto-discovery is robust.** Prefer `dev-browser --connect` with *no URL*: the daemon reads Chrome's `DevToolsActivePort` file and probes common CDP ports. This matters because Chrome can expose a working CDP WebSocket while `http://localhost:9222/json/version` still returns 404 — a bare 404 is **not** proof that CDP is unusable. To make a Chrome connectable, launch it with `chrome.exe --remote-debugging-port=9222` (or `google-chrome --remote-debugging-port=9222`).
- **`--headless` and `--ignore-https-errors` only affect *managed* browsers** (`--browser`). They do nothing to an external Chrome reached through `--connect` — you cannot make someone's already-open Chrome headless.
- **Each `--browser <name>` is a separate persistent profile.** Reusing a name resumes that exact profile, logins and all. Use stable, descriptive names (`--browser linkedin-scrape`), not throwaways.
- **`--connect` never launches Chrome for you.** If nothing is listening, it reports a discovery/attach failure; start Chrome with a debugging port first.

## Decision 2 — the same-profile, many-tabs model (the core strength)

This is the capability most people underuse. A browser you drive — whether the user's connected Chrome or a managed profile — is **one profile = one cookie jar = one authenticated session**. Every tab inside it shares that session. Dev Browser lets you address any number of those tabs individually while they all stay logged in as the same person.

Concretely, a *page* is addressed one of two ways, and both live in the same shared context:

- **A named page** — `browser.getPage("feed")` in a script, or `--page feed` on a command. The name is yours. The first use opens (or, when connecting, reuses) a tab; every later use with the same name returns that same tab. Named pages **persist across script runs** for the lifetime of that browser, so you navigate once and keep interacting run after run without re-loading.
- **An existing tab by target id** — `browser.getPage("<targetId>")` / `--page <targetId>`. You get the ids from `listPages()` / the `pages` command. This attaches to a tab that already exists (including tabs the user opened themselves). In `--connect` mode, dev-browser attaches **only the target you name**, not every renderer — which is what makes a heavily loaded Chrome (dozens of tabs) usable instead of overwhelming.

Why this matters, with a real shape of work: you connect to one logged-in Chrome and drive several tabs at once — a `profiles` tab paging through search results, a `detail` tab opening individual pages, an `export` tab — all sharing the single login. You never re-authenticate, and each tab is independently perceivable and clickable. For a scraping pipeline against one account, this is the whole game: one session, many concurrent working surfaces.

Discovery and hygiene commands:

```bash
# List every tab in the profile: named pages AND the user's own tabs.
# Returns [{ id, url, title, name }]; name is null for tabs you didn't name.
dev-browser --connect pages
```

```javascript
// Same thing inside a script, then attach to a specific one.
const tabs = await browser.listPages();
const target = tabs.find(t => t.url.includes("app.example.com"));
const page = await browser.getPage(target.id);   // attach that exact tab
```

Rules that keep this safe and predictable:

- **Never close a tab you did not open.** `browser.closePage(name)` and closing only apply to pages your automation created (or that the user explicitly asked to close). When connecting, dev-browser deliberately leaves the user's existing tabs *unnamed* so a stray `getPage("main")` opens a fresh tab instead of hijacking one of theirs.
- **Don't hardcode target ids across runs.** Re-list with `pages` / `listPages()` each time. Ids are re-enumerated, and a restart of a *managed* browser gives entirely new ones. Match tabs by **both** URL and title (either can be stale or duplicated), never by position.
- **`browser.newPage()`** makes an anonymous tab that is cleaned up when the script exits — use it for throwaway work, not for state you want to keep.
