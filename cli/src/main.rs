mod connection;
mod daemon;
mod interactive;
mod skill;
#[path = "wait-grammar.rs"]
mod wait_grammar;

use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum};
use connection::{connect_to_daemon, read_line, send_message};
use daemon::{
    current_daemon_pid, ensure_daemon, install_daemon_runtime, is_daemon_running,
    wait_for_daemon_exit,
};
use interactive::{
    apply_state_guard, build_interactive_request, build_observe_action, build_primitive_action,
    Coordinates, InteractiveRequestOptions, ObserveActionOptions,
};
use serde::Deserialize;
use serde_json::{json, Value};
use skill::install_skill;
use std::error::Error;
use std::fs;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::process;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use wait_grammar::WaitArgs;

const CLI_LONG_ABOUT: &str = r###"Dev Browser is a CLI for controlling local or external browsers with JavaScript scripts.
Scripts run in a sandboxed QuickJS runtime (not Node.js). Top-level `await` is
available, along with a preconnected `browser` global and standard `console` output.
A background daemon starts automatically when needed and manages browser instances,
named pages, and CDP connections.

SANDBOX ENVIRONMENT:
  Scripts execute inside a QuickJS WASM sandbox with no arbitrary access to the host system.
  This is NOT Node.js — the following are NOT available:
    - require() / import()     No module loading
    - process                  No process access
    - fs / path / os           No direct filesystem access
    - fetch / WebSocket        No direct network access
    - __dirname / __filename   No path globals

  Available globals:
    browser                    Pre-connected browser handle (see API below)
    console                    log, warn, error, info (routed to CLI output)
    setTimeout / clearTimeout  Basic timers
    saveScreenshot(buf, name)  Save a screenshot buffer (async, must be awaited)
    writeFile(name, data)      Write a file to temp dir (async, must be awaited)
    readFile(name)             Read a file from temp dir (async, must be awaited)

  Memory and CPU limits are enforced. Infinite loops will be interrupted.

Primary invocation styles:
  dev-browser <<'EOF'
    const page = await browser.getPage("main");
    await page.goto("https://example.com");
    console.log(await page.title());
  EOF

  dev-browser run script.js
  dev-browser --browser my-project < script.js
  dev-browser --connect http://localhost:9222 <<'EOF'
    const page = await browser.getPage("main");
    await page.goto("https://example.com");
  EOF
  dev-browser --connect <<'EOF'
    const page = await browser.getPage("main");
    console.log(await page.title());
  EOF

Connecting to a running Chrome:
  Prefer `dev-browser --connect` without a URL for existing user Chrome sessions.
  The daemon first reads Chrome's DevToolsActivePort file, then probes common CDP ports.
  This matters because Chrome can expose a valid WebSocket while
  http://localhost:9222/json/version returns 404.

  If you pass a URL, HTTP endpoints such as http://localhost:9222 are resolved
  to ws://... endpoints when possible. If that fails, read DevToolsActivePort and
  pass the exact ws://127.0.0.1:<port>/devtools/browser/... URL.

  `--timeout SECONDS` applies to both Playwright's CDP attach step and the script
  execution step. If attach behavior changes after an upgrade or environment
  change, run `dev-browser stop` so the daemon restarts with the latest runtime.

Script API available inside every script:
  browser.getPage(nameOrId) Get a page by name (creates if new) or connect to an existing
                            tab by its targetId from listPages().
  browser.newPage()       Create an anonymous page. Anonymous pages are cleaned up after the script exits.
  browser.listPages()       List all tabs: named pages and existing browser tabs.
                            Returns [{id, url, title, name}].
  browser.closePage(name) Close and remove a named page.
  await saveScreenshot(buf: Buffer, name: string): Promise<string>
                          Save a screenshot buffer to ~/.dev-browser/tmp/<name>.
                          Returns the full path to the saved file.
                          Example: const path = await saveScreenshot(await page.screenshot(), "home.png");

  await writeFile(name: string, data: string): Promise<string>
                          Write data to ~/.dev-browser/tmp/<name>.
                          Returns the full path to the written file.
                          Example: const path = await writeFile("results.json", JSON.stringify(data));

  await readFile(name: string): Promise<string>
                          Read a file from ~/.dev-browser/tmp/<name>.
                          Returns the file content as a string.
                          Example: const data = JSON.parse(await readFile("results.json"));

  console.log/info(...)   Write output to stdout.
  console.warn/error(...) Write output to stderr.

  All file I/O functions are async and must be awaited.
  All paths are restricted to ~/.dev-browser/tmp/ — no filesystem escape.

Pages returned by `browser.getPage()` and `browser.newPage()` are full Playwright
Page objects — you get the same API (goto, click, fill, locator, evaluate, etc.):
  https://playwright.dev/docs/api/class-page"###;

const CLI_AFTER_LONG_HELP: &str = include_str!("../llm-guide.txt");

const DEFAULT_SCRIPT_TIMEOUT_SECS: u32 = 30;

#[derive(Parser)]
#[command(name = "dev-browser")]
#[command(about = "Control browsers with JavaScript automation scripts")]
#[command(long_about = CLI_LONG_ABOUT)]
#[command(after_long_help = CLI_AFTER_LONG_HELP)]
#[command(subcommand_precedence_over_arg = true)]
struct Cli {
    #[arg(
        long,
        default_value = "default",
        value_name = "NAME",
        help = "Use a named daemon-managed browser instance",
        long_help = "Select the named browser instance to run against.\n\nThe daemon keeps separate browser state for each name. Named pages created with `browser.getPage(\"name\")` persist within that browser between script runs.\n\nDefaults to `default`."
    )]
    browser: String,

    #[arg(
        long,
        value_name = "SESSION_ID",
        help = "Authorize script execution while this browser has a writer lease"
    )]
    session: Option<String>,

    #[arg(
        long,
        num_args = 0..=1,
        default_missing_value = "auto",
        value_name = "URL",
        help = "Connect to a running Chrome instance",
        long_help = "Connect to a running Chrome instance.\n\nRecommended for agents: use `dev-browser --connect` without a URL first. The daemon reads Chrome's DevToolsActivePort file and then probes common CDP ports, so it can still connect when `http://localhost:9222/json/version` returns 404.\n\nWith a URL: connects to the specified CDP endpoint. Accepts HTTP or WebSocket CDP endpoints such as `http://localhost:9222` or `ws://host:9222/devtools/browser/...`. If an HTTP endpoint returns 404, dev-browser tries the matching DevToolsActivePort entry before failing.\n\nIf Playwright reports `<ws connected>` and then times out, Chrome/CDP is reachable but Playwright did not finish attaching. Retry with a shorter `--timeout`, run `dev-browser stop` to restart the daemon, or pass the exact ws://... endpoint from DevToolsActivePort.\n\nTo launch Chrome with debugging, use a command such as:\n  chrome.exe --remote-debugging-port=9222\n  google-chrome --remote-debugging-port=9222\n\nOr visit chrome://inspect/#remote-debugging to configure."
    )]
    connect: Option<String>,

    #[arg(
        long,
        help = "Launch daemon-managed Chromium without a visible window",
        long_help = "Launch or relaunch daemon-managed Chromium in headless mode.\n\nThis only affects daemon-launched browsers. It has no effect when `--connect` attaches to an already-running external browser."
    )]
    headless: bool,

    #[arg(
        long,
        help = "Ignore HTTPS certificate errors for daemon-managed Chromium",
        long_help = "Launch or relaunch daemon-managed Chromium with HTTPS certificate errors ignored.\n\nThis is useful for self-signed certificates in local or staging environments. The setting applies per managed browser session until the daemon restarts or the setting changes and triggers a relaunch.\n\nThis only affects daemon-launched browsers. It has no effect when `--connect` attaches to an already-running external browser."
    )]
    ignore_https_errors: bool,

    #[arg(
        long,
        default_value_t = DEFAULT_SCRIPT_TIMEOUT_SECS,
        value_name = "SECONDS",
        value_parser = clap::value_parser!(u32).range(1..),
        help = "Maximum script execution time in seconds",
        long_help = "Maximum time in seconds for script execution.\n\nWhen `--connect` is used, the same value is also passed to Playwright's CDP attach step, so `--timeout 10` fails a stuck Chrome attach in about 10 seconds instead of Playwright's default 30 seconds.\n\nDefaults to 30 seconds."
    )]
    timeout: u32,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Args)]
struct PageTargetArgs {
    #[arg(
        long,
        default_value = "main",
        value_name = "NAME_OR_TARGET_ID",
        help = "Select a persistent named page or an existing target ID"
    )]
    page: String,
}

#[derive(Args)]
struct PageActionArgs {
    #[command(flatten)]
    target: PageTargetArgs,

    #[arg(
        long,
        num_args = 0..=1,
        default_missing_value = "auto",
        value_name = "FILE",
        help = "Save the resulting page screenshot and return its absolute path"
    )]
    shot: Option<String>,

    #[arg(
        long,
        help = "Draw deterministic ref labels on the returned screenshot"
    )]
    annotate: bool,

    #[arg(
        long,
        help = "Capture document CSS pixels instead of the current viewport"
    )]
    full_page: bool,

    #[arg(long, value_name = "STATE")]
    from_state: Option<String>,

    #[arg(long)]
    strict_state: bool,

    #[arg(long, value_name = "SESSION_ID")]
    session: Option<String>,
}

#[derive(Subcommand)]
enum SessionCommand {
    Open {
        #[arg(long, default_value = "default")]
        browser: String,
        #[arg(long, value_name = "TARGET")]
        page: String,
        #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u16).range(1..=3600))]
        ttl: u16,
    },
    Renew {
        #[arg(long, value_name = "SESSION_ID")]
        session: String,
        #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u16).range(1..=3600))]
        ttl: u16,
    },
    Close {
        #[arg(long, value_name = "SESSION_ID")]
        session: String,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum ClickMethod {
    Mouse,
    Locator,
}

impl ClickMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mouse => "mouse",
            Self::Locator => "locator",
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum RetryPolicy {
    Never,
    Safe,
    Once,
}

#[derive(Clone, Copy, ValueEnum)]
enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone, Copy, ValueEnum)]
enum NameMode {
    Exact,
    Contains,
}
impl NameMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Contains => "contains",
        }
    }
}
#[derive(Clone, Copy, ValueEnum)]
enum FindScope {
    Visible,
    Viewport,
    Document,
}
impl FindScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Visible => "visible",
            Self::Viewport => "viewport",
            Self::Document => "document",
        }
    }
}
#[derive(Clone, Copy, ValueEnum)]
enum FindState {
    Enabled,
    Disabled,
    Checked,
    Unchecked,
    Expanded,
    Collapsed,
    Selected,
}
impl FindState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::Checked => "checked",
            Self::Unchecked => "unchecked",
            Self::Expanded => "expanded",
            Self::Collapsed => "collapsed",
            Self::Selected => "selected",
        }
    }
}
impl ScrollDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

impl RetryPolicy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::Safe => "safe",
            Self::Once => "once",
        }
    }
}

fn apply_retry_policy(action: &mut Value, retry: RetryPolicy) {
    action["retry"] = Value::String(retry.as_str().to_string());
}

#[derive(Subcommand)]
enum Command {
    #[command(
        subcommand,
        about = "Open, renew, or close an optional page writer lease"
    )]
    Session(SessionCommand),
    #[command(
        about = "Run a script file against the browser",
        long_about = "Run a script file against the browser.\n\nThe file is executed the same way as stdin input: as top-level JavaScript with `await`, `browser`, and `console` available.\n\nUse top-level flags before `run`, for example `dev-browser --browser my-project run script.js`."
    )]
    Run {
        #[arg(
            value_name = "FILE",
            help = "Path to a JavaScript file to execute",
            long_help = "Path to the JavaScript file to execute.\n\nThis is equivalent to `dev-browser < script.js`, but can be easier to script or combine with shell tooling."
        )]
        file: String,
    },
    #[command(
        about = "List persistent and existing browser pages without attaching every target",
        long_about = "List persistent named pages and existing Chrome targets. Use the returned target ID with read, find, click, type, confirm, or shot when operating an existing user tab."
    )]
    Pages,
    #[command(
        about = "Navigate one persistent page and return its resulting state",
        long_about = "Navigate a persistent named page or existing target to a URL with waitUntil=domcontentloaded. Add --shot to save and return a PNG after navigation."
    )]
    Navigate {
        #[arg(value_name = "URL")]
        url: String,
        #[command(flatten)]
        output: PageActionArgs,
    },
    Back {
        #[command(flatten)]
        output: PageActionArgs,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Forward {
        #[command(flatten)]
        output: PageActionArgs,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Reload {
        #[command(flatten)]
        output: PageActionArgs,
        #[command(flatten)]
        wait: WaitArgs,
    },
    #[command(
        about = "Observe a compact, actionable page state",
        long_about = "Return the protocol v2 page state with stable inline refs, coordinate metadata, deterministic truncation, and optional deltas."
    )]
    Observe {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long)]
        full: bool,
        #[arg(long)]
        delta: bool,
        #[arg(long, default_value = "default", value_name = "KEY")]
        track: String,
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u16).range(1..=1000))]
        max_nodes: u16,
        #[arg(long, default_value_t = 12_000, value_parser = clap::value_parser!(u32).range(1..=100000))]
        max_chars: u32,
        #[arg(long, default_value_t = 12, value_parser = clap::value_parser!(u8).range(1..=50))]
        depth: u8,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=500))]
        breadth: u16,
        #[arg(long, value_name = "CURSOR")]
        continuation: Option<String>,
    },
    #[command(
        about = "Read the accessibility snapshot and interactive refs for a page",
        long_about = "Return an accessibility snapshot plus stable DOM refs for interactive elements. Each ref includes role, name, visibility, viewport coordinates, and its main/aside/dialog landmark path. Run read again after a rerender before using old refs."
    )]
    Read {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u16).range(1..=500))]
        limit: u16,
        #[arg(long, default_value_t = 12, value_parser = clap::value_parser!(u8).range(1..=50))]
        depth: u8,
    },
    #[command(
        about = "Find interactive refs by accessible name, role, and landmark",
        long_about = "Take a fresh accessibility snapshot, then rank visible interactive elements against a natural-language query. Names, roles, and landmarks such as main.profile-card or aside are scored separately so duplicate labels can be disambiguated."
    )]
    #[command(group(clap::ArgGroup::new("find_target").required(true).multiple(true)))]
    Find {
        #[arg(value_name = "QUERY", group = "find_target")]
        query: Option<String>,
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long, group = "find_target")]
        role: Option<String>,
        #[arg(long, group = "find_target")]
        name: Option<String>,
        #[arg(long, value_enum, default_value = "exact", requires = "name")]
        name_mode: NameMode,
        #[arg(long, group = "find_target")]
        within: Option<String>,
        #[arg(long, group = "find_target")]
        near: Option<String>,
        #[arg(long, group = "find_target")]
        frame: Option<String>,
        #[arg(long, value_enum, default_value = "visible")]
        scope: FindScope,
        #[arg(long = "state", value_enum, action = clap::ArgAction::Append, group = "find_target")]
        states: Vec<FindState>,
        #[arg(long, value_parser = clap::value_parser!(u16).range(0..=999))]
        index: Option<u16>,
        #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u8).range(1..=50))]
        limit: u8,
    },
    #[command(
        about = "Click through trusted Playwright mouse or locator input",
        long_about = "Click exactly one ref or X,Y coordinate with trusted Playwright input, then return a fresh accessibility snapshot and change signals. Mouse mode clicks the center of a ref's current bounding box. Locator mode uses locator.click(). Retries default to never; --retry safe permits one retry only with strong evidence that no side effect or page change began, while --retry once is explicit but remains blocked for guarded or irreversible actions. Screenshot pixels and --xy coordinates both use CSS pixels."
    )]
    Click {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(
            long = "ref",
            value_name = "REF",
            conflicts_with = "xy",
            required_unless_present = "xy"
        )]
        ref_id: Option<String>,
        #[arg(
            long,
            value_name = "X,Y",
            conflicts_with = "ref_id",
            required_unless_present = "ref_id"
        )]
        xy: Option<Coordinates>,
        #[arg(long, value_enum, default_value = "mouse")]
        method: ClickMethod,
        #[arg(long, value_enum, default_value = "never")]
        retry: RetryPolicy,
        #[arg(long, value_name = "TEXT")]
        expect_text: Option<String>,
        #[arg(long, value_name = "TEXT")]
        wait_for: Option<String>,
        #[command(flatten)]
        wait: WaitArgs,
    },
    #[command(
        about = "Focus and type through trusted Playwright keyboard input",
        long_about = "Focus an optional interactive ref with a real mouse click and type through page.keyboard. Use --clear to select and replace existing input or contenteditable text."
    )]
    Type {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long = "ref", value_name = "REF")]
        ref_id: Option<String>,
        #[arg(long, value_name = "TEXT")]
        text: String,
        #[arg(long)]
        clear: bool,
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u16).range(0..=1000))]
        delay: u16,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Focus {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long = "ref")]
        ref_id: String,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Press {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long = "ref")]
        ref_id: String,
        #[arg(long)]
        key: String,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Paste {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long = "ref")]
        ref_id: String,
        #[arg(long, required = true, conflicts_with_all = ["shot", "annotate"])]
        text_stdin: bool,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Scroll {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long = "ref", conflicts_with_all = ["delta_y", "direction", "until"], required_unless_present_any = ["delta_y", "direction", "until"])]
        ref_id: Option<String>,
        #[arg(long, allow_hyphen_values = true, conflicts_with_all = ["ref_id", "direction", "until"], required_unless_present_any = ["ref_id", "direction", "until"])]
        delta_y: Option<f64>,
        #[arg(long, allow_hyphen_values = true, requires = "delta_y")]
        delta_x: Option<f64>,
        #[arg(long, value_enum, conflicts_with_all = ["ref_id", "delta_y", "until"], requires = "pages", required_unless_present_any = ["ref_id", "delta_y", "until"])]
        direction: Option<ScrollDirection>,
        #[arg(long, value_parser = clap::value_parser!(u8).range(1..=50), requires = "direction")]
        pages: Option<u8>,
        #[arg(long, conflicts_with_all = ["ref_id", "delta_y", "direction"], requires = "max_steps", required_unless_present_any = ["ref_id", "delta_y", "direction"])]
        until: Option<String>,
        #[arg(long, value_parser = clap::value_parser!(u8).range(1..=50), requires = "until")]
        max_steps: Option<u8>,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Select {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long = "ref")]
        ref_id: String,
        #[arg(long, conflicts_with = "label", required_unless_present = "label")]
        value: Option<String>,
        #[arg(long, conflicts_with = "value", required_unless_present = "value")]
        label: Option<String>,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Check {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long = "ref")]
        ref_id: String,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Uncheck {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long = "ref")]
        ref_id: String,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Hover {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long = "ref")]
        ref_id: String,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Drag {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long)]
        from: String,
        #[arg(long)]
        to: String,
        #[command(flatten)]
        wait: WaitArgs,
    },
    Upload {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long = "ref", value_name = "REF", required = true)]
        ref_id: String,
        #[arg(long, value_name = "TEMP_FILE", required = true)]
        file: String,
        #[command(flatten)]
        wait: WaitArgs,
    },
    #[command(
        about = "Read and verify the current confirmation or dialog text",
        long_about = "Return visible dialog text, falling back to visible body text. --expect makes the command fail unless the supplied recipient or confirmation text is present. Use this before an irreversible final click."
    )]
    Confirm {
        #[command(flatten)]
        output: PageActionArgs,
        #[arg(long, value_name = "TEXT")]
        expect: Option<String>,
    },
    #[command(
        about = "Save a page screenshot and return its absolute PNG path",
        long_about = "Capture a persistent named page or existing target and write it under ~/.dev-browser/tmp. Agents must open the returned absolute path with an image-viewing tool before the next consequential action."
    )]
    Shot {
        #[command(flatten)]
        target: PageTargetArgs,
        #[arg(value_name = "FILE", default_value = "auto")]
        file: String,
        #[arg(long = "ref", value_name = "REF")]
        ref_id: Option<String>,
        #[arg(long, default_value_t = 32, value_parser = clap::value_parser!(u16).range(0..=1000))]
        padding: u16,
        #[arg(long)]
        full_page: bool,
        #[arg(long)]
        annotate: bool,
        #[arg(long, value_name = "STATE")]
        from_state: Option<String>,
        #[arg(long)]
        strict_state: bool,
        #[arg(long, value_name = "SESSION_ID")]
        session: Option<String>,
    },
    #[command(
        about = "Install Playwright browsers (Chromium)",
        long_about = "Install Playwright browsers (Chromium).\n\nDownloads the Chromium build used for daemon-managed browser instances."
    )]
    Install,
    #[command(
        about = "Install the dev-browser skill into agent skill directories",
        long_about = "Install the embedded dev-browser skill into agent skill directories.\n\nBy default, launches an interactive multi-select prompt for the supported install targets when a TTY is available.\n\nIn non-interactive environments, installs to both supported skill directories.\n\nUse `--claude` and/or `--agents` to skip prompting and install to specific targets."
    )]
    InstallSkill {
        #[arg(
            long,
            help = "Install the skill into ~/.claude/skills without prompting"
        )]
        claude: bool,
        #[arg(
            long,
            help = "Install the skill into ~/.agents/skills without prompting"
        )]
        agents: bool,
    },
    #[command(
        about = "List all managed browser instances",
        long_about = "List all managed browser instances.\n\nShows the browser name, whether it is daemon-launched or externally connected, its status, and any named pages currently registered."
    )]
    Browsers,
    #[command(
        about = "Show daemon status",
        long_about = "Show daemon status.\n\nPrints daemon process details, socket path, uptime, and the current set of managed browsers."
    )]
    Status,
    #[command(
        about = "Stop the daemon and all browsers",
        long_about = "Stop the daemon and all browsers.\n\nThis stops the background daemon process and closes every browser instance it currently manages."
    )]
    Stop,
}

#[derive(Debug, Deserialize)]
struct BrowserSummary {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    status: String,
    pages: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct StatusSummary {
    pid: i32,
    #[serde(rename = "uptimeMs")]
    uptime_ms: u64,
    #[serde(rename = "browserCount")]
    browser_count: usize,
    #[serde(rename = "socketPath")]
    socket_path: String,
    browsers: Vec<BrowserSummary>,
}

enum ResultMode {
    None,
    Json,
    Browsers,
    Status,
}

fn main() {
    let exit_code = match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {error}");
            cli_error_exit_code(error.as_ref())
        }
    };

    process::exit(exit_code);
}

fn cli_error_exit_code(error: &(dyn Error + 'static)) -> i32 {
    match error.downcast_ref::<io::Error>().map(io::Error::kind) {
        Some(io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData) => 2,
        _ => 6,
    }
}

fn run() -> Result<i32, Box<dyn Error>> {
    let cli = Cli::parse();

    match &cli.command {
        Some(Command::Run { file }) => {
            let script = fs::read_to_string(file)?;
            run_script(&cli, script)
        }
        Some(Command::Pages) => run_interactive(
            &cli,
            "main",
            None,
            false,
            false,
            json!({ "kind": "pages" }),
            None,
        ),
        Some(Command::Navigate { url, output }) => {
            run_page_action(&cli, output, json!({ "kind": "navigate", "url": url }))
        }
        Some(Command::Back { output, wait }) => {
            let mut action = json!({ "kind": "back" });
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Forward { output, wait }) => {
            let mut action = json!({ "kind": "forward" });
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Reload { output, wait }) => {
            let mut action = json!({ "kind": "reload" });
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Observe {
            output,
            full,
            delta,
            track,
            max_nodes,
            max_chars,
            depth,
            breadth,
            continuation,
        }) => run_page_action(
            &cli,
            output,
            build_observe_action(ObserveActionOptions {
                full: *full,
                delta: *delta,
                track,
                max_nodes: *max_nodes,
                max_chars: *max_chars,
                depth: *depth,
                breadth: *breadth,
                continuation: continuation.as_deref(),
            }),
        ),
        Some(Command::Read {
            output,
            limit,
            depth,
        }) => run_page_action(
            &cli,
            output,
            json!({ "kind": "read", "limit": limit, "depth": depth }),
        ),
        Some(Command::Find {
            query,
            output,
            role,
            name,
            name_mode,
            within,
            near,
            frame,
            scope,
            states,
            index,
            limit,
        }) => {
            let action = build_find_action(
                query.as_deref(),
                role.as_deref(),
                name.as_deref(),
                name_mode.as_str(),
                within.as_deref(),
                near.as_deref(),
                frame.as_deref(),
                scope.as_str(),
                &states
                    .iter()
                    .map(|state| state.as_str())
                    .collect::<Vec<_>>(),
                *index,
                *limit,
            );
            run_page_action(&cli, output, action)
        }
        Some(Command::Click {
            output,
            ref_id,
            xy,
            method,
            retry,
            expect_text,
            wait_for,
            wait,
        }) => {
            if xy.is_some() && matches!(method, ClickMethod::Locator) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "--method locator requires --ref; coordinate clicks always use the mouse",
                )
                .into());
            }
            let mut action = json!({
                "kind": "click",
                "method": method.as_str(),
            });
            apply_retry_policy(&mut action, *retry);
            if let Some(ref_id) = ref_id {
                action["ref"] = Value::String(ref_id.clone());
            }
            if let Some(coordinates) = xy {
                action["x"] = json!(coordinates.x);
                action["y"] = json!(coordinates.y);
            }
            if let Some(expect_text) = expect_text {
                action["expectText"] = Value::String(expect_text.clone());
            }
            if let Some(wait_for) = wait_for {
                action["waitForText"] = Value::String(wait_for.clone());
            }
            if let Some(spec) = wait
                .build_spec(wait_for.as_deref())
                .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?
            {
                action["wait"] = spec;
            }
            run_page_action(&cli, output, action)
        }
        Some(Command::Type {
            output,
            ref_id,
            text,
            clear,
            delay,
            wait,
        }) => {
            let mut action = json!({
                "kind": "type",
                "text": text,
                "clear": clear,
                "delayMs": delay,
            });
            if let Some(ref_id) = ref_id {
                action["ref"] = Value::String(ref_id.clone());
            }
            if let Some(spec) = wait
                .build_spec(None)
                .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?
            {
                action["wait"] = spec;
            }
            run_page_action(&cli, output, action)
        }
        Some(Command::Focus {
            output,
            ref_id,
            wait,
        }) => {
            let mut action = build_primitive_action("focus", &[("ref", json!(ref_id))]);
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Press {
            output,
            ref_id,
            key,
            wait,
        }) => {
            let mut action =
                build_primitive_action("press", &[("ref", json!(ref_id)), ("key", json!(key))]);
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Paste {
            output,
            ref_id,
            text_stdin: _,
            wait,
        }) => {
            let text = read_script_from_stdin()?;
            let mut action =
                build_primitive_action("paste", &[("ref", json!(ref_id)), ("text", json!(text))]);
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Scroll {
            output,
            ref_id,
            delta_y,
            delta_x,
            direction,
            pages,
            until,
            max_steps,
            wait,
        }) => {
            let mut action = json!({ "kind": "scroll" });
            if let Some(value) = ref_id {
                action["ref"] = json!(value);
            }
            if let Some(value) = delta_y {
                action["deltaY"] = json!(value);
            }
            if let Some(value) = delta_x {
                action["deltaX"] = json!(value);
            }
            if let Some(value) = direction {
                action["direction"] = json!(value.as_str());
            }
            if let Some(value) = pages {
                action["pages"] = json!(value);
            }
            if let Some(value) = until {
                action["until"] = json!(value);
            }
            if let Some(value) = max_steps {
                action["maxSteps"] = json!(value);
            }
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Select {
            output,
            ref_id,
            value,
            label,
            wait,
        }) => {
            let mut action = json!({ "kind": "select", "ref": ref_id });
            if let Some(value) = value {
                action["value"] = json!(value);
            }
            if let Some(label) = label {
                action["label"] = json!(label);
            }
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Check {
            output,
            ref_id,
            wait,
        })
        | Some(Command::Uncheck {
            output,
            ref_id,
            wait,
        })
        | Some(Command::Hover {
            output,
            ref_id,
            wait,
        }) => {
            let kind = match &cli.command {
                Some(Command::Check { .. }) => "check",
                Some(Command::Uncheck { .. }) => "uncheck",
                _ => "hover",
            };
            let mut action = json!({ "kind": kind, "ref": ref_id });
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Drag {
            output,
            from,
            to,
            wait,
        }) => {
            let mut action = json!({ "kind": "drag", "from": from, "to": to });
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Upload {
            output,
            ref_id,
            file,
            wait,
        }) => {
            let mut action =
                build_primitive_action("upload", &[("ref", json!(ref_id)), ("file", json!(file))]);
            apply_wait(&mut action, wait)?;
            run_page_action(&cli, output, action)
        }
        Some(Command::Confirm { output, expect }) => {
            let mut action = json!({ "kind": "confirm" });
            if let Some(expect) = expect {
                action["expectText"] = Value::String(expect.clone());
            }
            run_page_action(&cli, output, action)
        }
        Some(Command::Shot {
            target,
            file,
            ref_id,
            padding,
            full_page,
            annotate,
            from_state,
            strict_state,
            session,
        }) => {
            let mut action = json!({ "kind": "shot", "padding": padding });
            if let Some(ref_id) = ref_id {
                action["ref"] = Value::String(ref_id.clone());
            }
            if let Some(from_state) = from_state {
                action["fromState"] = Value::String(from_state.clone());
            }
            if *strict_state {
                action["strictState"] = Value::Bool(true);
            }
            run_interactive(
                &cli,
                &target.page,
                Some(file),
                *annotate,
                *full_page,
                action,
                session.as_deref(),
            )
        }
        Some(Command::Session(command)) => {
            ensure_daemon()?;
            let request = match command {
                SessionCommand::Open { browser, page, ttl } => {
                    json!({ "id": request_id("session-open"), "type": "session", "action": "open", "browser": browser, "page": page, "ttl": ttl })
                }
                SessionCommand::Renew { session, ttl } => {
                    json!({ "id": request_id("session-renew"), "type": "session", "action": "renew", "session": session, "ttl": ttl })
                }
                SessionCommand::Close { session } => {
                    json!({ "id": request_id("session-close"), "type": "session", "action": "close", "session": session })
                }
            };
            send_request(request, ResultMode::Json)
        }
        Some(Command::Browsers) => {
            ensure_daemon()?;
            send_request(
                json!({
                    "id": request_id("browsers"),
                    "type": "browsers",
                }),
                ResultMode::Browsers,
            )
        }
        Some(Command::Install) => {
            install_daemon_runtime()?;
            Ok(0)
        }
        Some(Command::InstallSkill { claude, agents }) => {
            install_skill(*claude, *agents)?;
            Ok(0)
        }
        Some(Command::Status) => {
            ensure_daemon()?;
            send_request(
                json!({
                    "id": request_id("status"),
                    "type": "status",
                }),
                ResultMode::Status,
            )
        }
        Some(Command::Stop) => {
            if !is_daemon_running() {
                println!("Daemon is not running.");
                return Ok(0);
            }

            let daemon_pid = current_daemon_pid();

            let exit_code = send_request(
                json!({
                    "id": request_id("stop"),
                    "type": "stop",
                }),
                ResultMode::None,
            )?;

            if exit_code == 0 {
                if let Some(pid) = daemon_pid {
                    wait_for_daemon_exit(pid, Duration::from_secs(10))?;
                }
                println!("Daemon stopped.");
            }

            Ok(exit_code)
        }
        None => {
            if stdin_is_tty() {
                let mut command = Cli::command();
                command.print_help()?;
                println!();
                return Ok(2);
            }

            let script = read_script_from_stdin()?;
            run_script(&cli, script)
        }
    }
}

fn run_script(cli: &Cli, script: String) -> Result<i32, Box<dyn Error>> {
    ensure_daemon()?;

    let timeout_ms = timeout_ms(cli)?;

    let mut request = build_execute_request(
        request_id("execute"),
        &cli.browser,
        script,
        timeout_ms,
        cli.session.as_deref(),
    );

    if cli.headless {
        request["headless"] = Value::Bool(true);
    }

    if cli.ignore_https_errors {
        request["ignoreHTTPSErrors"] = Value::Bool(true);
    }

    if let Some(endpoint) = &cli.connect {
        request["connect"] = Value::String(endpoint.clone());
    }

    send_request(request, ResultMode::Json)
}

fn build_execute_request(
    id: String,
    browser: &str,
    script: String,
    timeout_ms: u64,
    session: Option<&str>,
) -> Value {
    let mut request = json!({
        "id": id,
        "type": "execute",
        "browser": browser,
        "script": script,
        "timeoutMs": timeout_ms,
    });
    if let Some(session) = session {
        request["session"] = Value::String(session.to_string());
    }
    request
}

fn run_page_action(
    cli: &Cli,
    output: &PageActionArgs,
    mut action: Value,
) -> Result<i32, Box<dyn Error>> {
    apply_state_guard(
        &mut action,
        output.from_state.as_deref(),
        output.strict_state,
    );
    run_interactive(
        cli,
        &output.target.page,
        output.shot.as_deref(),
        output.annotate,
        output.full_page,
        action,
        output.session.as_deref(),
    )
}

fn apply_wait(action: &mut Value, wait: &WaitArgs) -> Result<(), Box<dyn Error>> {
    if let Some(spec) = wait
        .build_spec(None)
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?
    {
        action["wait"] = spec;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_find_action(
    query: Option<&str>,
    role: Option<&str>,
    name: Option<&str>,
    name_mode: &str,
    within: Option<&str>,
    near: Option<&str>,
    frame: Option<&str>,
    scope: &str,
    states: &[&str],
    index: Option<u16>,
    limit: u8,
) -> Value {
    let mut action = json!({ "kind": "find", "scope": scope, "states": states, "limit": limit });
    if let Some(value) = query {
        action["query"] = json!(value);
    }
    if let Some(value) = role {
        action["role"] = json!(value);
    }
    if let Some(value) = name {
        action["name"] = json!(value);
        action["nameMode"] = json!(name_mode);
    }
    if let Some(value) = within {
        action["within"] = json!(value);
    }
    if let Some(value) = near {
        action["near"] = json!(value);
    }
    if let Some(value) = frame {
        action["frame"] = json!(value);
    }
    if let Some(value) = index {
        action["index"] = json!(value);
    }
    action
}

fn run_interactive(
    cli: &Cli,
    page: &str,
    shot: Option<&str>,
    annotate: bool,
    full_page: bool,
    action: Value,
    session: Option<&str>,
) -> Result<i32, Box<dyn Error>> {
    ensure_daemon()?;
    let action_name = action
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("action");
    let request = build_interactive_request(
        InteractiveRequestOptions {
            id: request_id(action_name),
            browser: &cli.browser,
            page,
            shot,
            annotate,
            full_page,
            connect: cli.connect.as_deref(),
            headless: cli.headless,
            ignore_https_errors: cli.ignore_https_errors,
            timeout_ms: timeout_ms(cli)?,
            session,
        },
        action,
    );
    send_request(request, ResultMode::Json)
}

fn timeout_ms(cli: &Cli) -> Result<u64, Box<dyn Error>> {
    u64::from(cli.timeout).checked_mul(1_000).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Timeout value is too large").into()
    })
}

fn send_request(message: Value, result_mode: ResultMode) -> Result<i32, Box<dyn Error>> {
    let mut stream = connect_to_daemon()?;
    send_message(&mut stream, &message)?;
    let mut reader = BufReader::new(stream);
    stream_responses(&mut reader, result_mode)
}

fn stream_responses<R: BufRead>(
    reader: &mut R,
    result_mode: ResultMode,
) -> Result<i32, Box<dyn Error>> {
    loop {
        let line = read_line(reader)?;
        let message: Value = serde_json::from_str(line.trim_end())?;

        match message.get("type").and_then(Value::as_str) {
            Some("stdout") => {
                if let Some(data) = message.get("data").and_then(Value::as_str) {
                    print!("{data}");
                    io::stdout().flush()?;
                }
            }
            Some("stderr") => {
                if let Some(data) = message.get("data").and_then(Value::as_str) {
                    eprint!("{data}");
                    io::stderr().flush()?;
                }
            }
            Some("result") => {
                if let Some(data) = message.get("data") {
                    render_result(data, &result_mode)?;
                }
            }
            Some("complete") => return Ok(0),
            Some("error") => {
                let error_message = message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown daemon error");
                eprintln!("{error_message}");
                return Ok(daemon_error_exit_code(&message));
            }
            _ => {}
        }
    }
}

/// Stable process statuses for daemon failures. Explicit daemon statuses win,
/// followed by Agent Reliability v2 typed codes; legacy errors remain status 1.
fn daemon_error_exit_code(message: &Value) -> i32 {
    if let Some(exit_code) = message
        .get("exitCode")
        .and_then(Value::as_i64)
        .filter(|code| (1..=255).contains(code))
    {
        return exit_code as i32;
    }

    let code = message
        .get("error")
        .and_then(|error| error.get("code"))
        .or_else(|| {
            message
                .get("data")
                .and_then(|data| data.get("error"))
                .and_then(|error| error.get("code"))
        })
        .and_then(Value::as_str);

    match code {
        Some(
            "STALE_REF"
            | "STALE_STATE"
            | "AMBIGUOUS_TARGET"
            | "TARGET_MISSING"
            | "TARGET_HIDDEN"
            | "TARGET_OBSCURED"
            | "TARGET_DISABLED"
            | "UNSUPPORTED_CONTEXT",
        ) => 3,
        Some("WAIT_TIMEOUT") => 4,
        Some("LEASE_CONFLICT") => 5,
        Some("DOWNLOAD_FAILED") => 7,
        Some(
            "PAGE_CLOSED"
            | "FRAME_DETACHED"
            | "POPUP_OPENED"
            | "CDP_DISCOVERY_FAILED"
            | "CDP_ATTACH_FAILED"
            | "RENDERER_UNRESPONSIVE"
            | "DAEMON_VERSION_MISMATCH"
            | "PROTOCOL_VERSION_MISMATCH",
        ) => 6,
        _ => 1,
    }
}

fn render_result(data: &Value, result_mode: &ResultMode) -> Result<(), Box<dyn Error>> {
    match result_mode {
        ResultMode::None => {}
        ResultMode::Json => {
            if data.is_null() {
                return Ok(());
            }

            if let Some(text) = data.as_str() {
                println!("{text}");
            } else {
                println!("{}", serde_json::to_string_pretty(data)?);
            }
        }
        ResultMode::Browsers => print_browsers(data)?,
        ResultMode::Status => print_status(data)?,
    }

    Ok(())
}

fn print_browsers(data: &Value) -> Result<(), Box<dyn Error>> {
    let browsers: Vec<BrowserSummary> = serde_json::from_value(data.clone())?;
    if browsers.is_empty() {
        println!("No browsers.");
        return Ok(());
    }

    let page_values: Vec<String> = browsers
        .iter()
        .map(|browser| {
            if browser.pages.is_empty() {
                "-".to_string()
            } else {
                browser.pages.join(", ")
            }
        })
        .collect();

    let name_width = browsers
        .iter()
        .map(|browser| browser.name.len())
        .max()
        .unwrap_or(4)
        .max("NAME".len());
    let type_width = browsers
        .iter()
        .map(|browser| browser.kind.len())
        .max()
        .unwrap_or(4)
        .max("TYPE".len());
    let status_width = browsers
        .iter()
        .map(|browser| browser.status.len())
        .max()
        .unwrap_or(6)
        .max("STATUS".len());

    println!(
        "{:<name_width$}  {:<type_width$}  {:<status_width$}  PAGES",
        "NAME", "TYPE", "STATUS"
    );

    for (browser, pages) in browsers.iter().zip(page_values.iter()) {
        println!(
            "{:<name_width$}  {:<type_width$}  {:<status_width$}  {}",
            browser.name, browser.kind, browser.status, pages
        );
    }

    Ok(())
}

fn print_status(data: &Value) -> Result<(), Box<dyn Error>> {
    let status: StatusSummary = serde_json::from_value(data.clone())?;

    println!("PID: {}", status.pid);
    println!("Uptime: {}", format_duration_ms(status.uptime_ms));
    println!("Browsers: {}", status.browser_count);
    println!("Socket: {}", status.socket_path);

    if !status.browsers.is_empty() {
        let managed = status
            .browsers
            .iter()
            .map(|browser| format!("{} ({}, {})", browser.name, browser.kind, browser.status))
            .collect::<Vec<_>>()
            .join(", ");
        println!("Managed: {managed}");
    }

    Ok(())
}

fn read_script_from_stdin() -> io::Result<String> {
    read_text_stream(&mut io::stdin())
}

fn read_text_stream(reader: &mut impl Read) -> io::Result<String> {
    let mut script = String::new();
    reader.read_to_string(&mut script)?;
    Ok(script)
}

fn stdin_is_tty() -> bool {
    io::stdin().is_terminal()
}

fn request_id(prefix: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{prefix}-{now}-{}", process::id())
}

fn format_duration_ms(duration_ms: u64) -> String {
    if duration_ms < 1_000 {
        return format!("{duration_ms}ms");
    }

    if duration_ms < 60_000 {
        return format!("{:.1}s", duration_ms as f64 / 1_000.0);
    }

    let total_seconds = duration_ms / 1_000;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes}m {seconds}s")
}

#[cfg(test)]
mod tests {
    use super::{
        apply_retry_policy, build_execute_request, build_find_action, build_primitive_action,
        cli_error_exit_code, read_text_stream, stream_responses, Cli, Command, ResultMode,
        SessionCommand,
    };
    use clap::Parser;
    use serde_json::json;
    use std::io::Cursor;

    fn response_exit_code(response: &str) -> i32 {
        stream_responses(&mut Cursor::new(response.as_bytes()), ResultMode::None).unwrap()
    }

    #[test]
    fn maps_typed_agent_errors_to_stable_exit_codes() {
        let cases = [
            ("STALE_REF", 3),
            ("AMBIGUOUS_TARGET", 3),
            ("TARGET_DISABLED", 3),
            ("WAIT_TIMEOUT", 4),
            ("LEASE_CONFLICT", 5),
            ("CDP_ATTACH_FAILED", 6),
            ("PROTOCOL_VERSION_MISMATCH", 6),
            ("DOWNLOAD_FAILED", 7),
        ];

        for (code, expected) in cases {
            let response = format!(
                "{{\"type\":\"error\",\"message\":\"failed\",\"error\":{{\"code\":\"{code}\",\"message\":\"failed\",\"recoverable\":false}}}}\n"
            );
            assert_eq!(response_exit_code(&response), expected, "{code}");
        }
    }

    #[test]
    fn prefers_explicit_exit_code_and_preserves_legacy_errors() {
        assert_eq!(
            response_exit_code("{\"type\":\"error\",\"message\":\"failed\",\"exitCode\":7}\n"),
            7
        );
        assert_eq!(
            response_exit_code("{\"type\":\"error\",\"message\":\"legacy failure\"}\n"),
            1
        );
    }

    #[test]
    fn maps_local_validation_and_runtime_errors() {
        let validation = std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid target");
        let runtime = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "offline");

        assert_eq!(cli_error_exit_code(&validation), 2);
        assert_eq!(cli_error_exit_code(&runtime), 6);
    }

    #[test]
    fn parses_interactive_agent_commands() {
        let commands = [
            vec![
                "dev-browser",
                "--connect",
                "read",
                "--page",
                "TARGET",
                "--shot",
                "state.png",
            ],
            vec![
                "dev-browser",
                "--connect",
                "find",
                "connect main profile",
                "--page",
                "TARGET",
            ],
            vec![
                "dev-browser",
                "--connect",
                "click",
                "--ref",
                "R12",
                "--page",
                "TARGET",
                "--expect-text",
                "Naminsita",
                "--wait-for",
                "Invitation sent",
            ],
            vec![
                "dev-browser",
                "--connect",
                "click",
                "--xy",
                "901,631",
                "--page",
                "TARGET",
            ],
            vec![
                "dev-browser",
                "--connect",
                "type",
                "--ref",
                "R13",
                "--text",
                "hello",
                "--clear",
                "--page",
                "TARGET",
            ],
        ];

        for command in commands {
            if let Err(error) = Cli::try_parse_from(command.clone()) {
                panic!("failed to parse {command:?}: {error}");
            }
        }
    }

    #[test]
    fn parses_navigation_and_upload_commands_with_required_targets() {
        for args in [
            vec!["dev-browser", "back", "--page", "TARGET"],
            vec!["dev-browser", "forward", "--page", "TARGET"],
            vec!["dev-browser", "reload", "--page", "TARGET"],
            vec![
                "dev-browser",
                "upload",
                "--ref",
                "R14",
                "--file",
                "C:\\Users\\tester\\.dev-browser\\tmp\\fixture.txt",
                "--page",
                "TARGET",
            ],
        ] {
            Cli::try_parse_from(args).unwrap();
        }
        assert!(Cli::try_parse_from(["dev-browser", "upload", "--ref", "R1"]).is_err());
        assert!(Cli::try_parse_from(["dev-browser", "upload", "--file", "fixture.txt"]).is_err());
    }

    #[test]
    fn parses_every_observe_flag() {
        let parsed = Cli::try_parse_from([
            "dev-browser",
            "observe",
            "--page",
            "TARGET",
            "--full",
            "--delta",
            "--track",
            "checkout",
            "--max-nodes",
            "999",
            "--max-chars",
            "99999",
            "--depth",
            "49",
            "--breadth",
            "499",
            "--continuation",
            "eyJ2IjoxLCJvZmZzZXQiOjN9",
            "--annotate",
            "--full-page",
        ])
        .unwrap();

        assert!(matches!(
            parsed.command,
            Some(Command::Observe {
                full: true,
                delta: true,
                ref track,
                max_nodes: 999,
                max_chars: 99_999,
                depth: 49,
                breadth: 499,
                continuation: Some(_),
                ref output,
                ..
            }) if track == "checkout" && output.annotate && output.full_page
        ));
    }

    #[test]
    fn parses_every_wait_flag_on_trusted_actions() {
        let flags = [
            "dev-browser",
            "click",
            "--ref",
            "R2",
            "--wait-mode",
            "any",
            "--wait-timeout",
            "1200",
            "--wait-text",
            "visible,body,contains,Saved",
            "--wait-url",
            "glob,**/done",
            "--wait-ref",
            "R7,attributeChanged,aria-expanded,true",
            "--wait-dialog",
            "opened",
            "--wait-toast",
            "closed",
            "--wait-popup",
            "--wait-download",
            "--wait-file-chooser",
            "--wait-navigation",
            "document",
            "--wait-response",
            "contains,/api,POST,200",
            "--wait-failed-request",
            "contains,/failure,GET",
            "--wait-network-idle",
            "250",
        ];
        let parsed = Cli::try_parse_from(flags).unwrap();
        assert!(
            matches!(parsed.command, Some(Command::Click { ref wait, .. }) if wait.build_spec(None).unwrap().unwrap()["conditions"].as_array().unwrap().len() == 12)
        );

        assert!(Cli::try_parse_from([
            "dev-browser",
            "type",
            "--text",
            "x",
            "--wait-mode",
            "sometimes",
            "--wait-popup"
        ])
        .is_err());
        assert!(Cli::try_parse_from([
            "dev-browser",
            "click",
            "--ref",
            "R1",
            "--wait-timeout",
            "120001",
            "--wait-popup"
        ])
        .is_err());
    }

    #[test]
    fn parses_and_serializes_every_click_retry_policy() {
        for policy in ["never", "safe", "once"] {
            let parsed =
                Cli::try_parse_from(["dev-browser", "click", "--ref", "R2", "--retry", policy])
                    .unwrap();
            let Some(Command::Click { retry, .. }) = parsed.command else {
                panic!("expected click command");
            };
            let mut action = serde_json::json!({ "kind": "click" });
            apply_retry_policy(&mut action, retry);
            assert_eq!(action["retry"], policy);
        }
        assert!(
            Cli::try_parse_from(["dev-browser", "click", "--ref", "R2", "--retry", "always"])
                .is_err()
        );
    }

    #[test]
    fn parses_action_annotation_and_focused_shot_options() {
        let click = Cli::try_parse_from([
            "dev-browser",
            "click",
            "--ref",
            "R2",
            "--annotate",
            "--full-page",
        ])
        .unwrap();
        assert!(matches!(
            click.command,
            Some(Command::Click { ref output, .. }) if output.annotate && output.full_page
        ));

        let shot = Cli::try_parse_from([
            "dev-browser",
            "shot",
            "focused.png",
            "--page",
            "TARGET",
            "--ref",
            "R7",
            "--padding",
            "32",
            "--full-page",
        ])
        .unwrap();
        assert!(matches!(
            shot.command,
            Some(Command::Shot { ref ref_id, padding: 32, full_page: true, .. })
                if ref_id.as_deref() == Some("R7")
        ));
    }

    #[test]
    fn parses_state_session_flags_and_all_session_commands() {
        let click = Cli::try_parse_from([
            "dev-browser",
            "click",
            "--ref",
            "R2",
            "--from-state",
            "doc-1:7",
            "--strict-state",
            "--session",
            "opaque-session",
        ])
        .unwrap();
        assert!(
            matches!(click.command, Some(Command::Click { ref output, .. })
            if output.from_state.as_deref() == Some("doc-1:7") && output.strict_state
                && output.session.as_deref() == Some("opaque-session"))
        );

        for args in [
            vec![
                "dev-browser",
                "session",
                "open",
                "--browser",
                "default",
                "--page",
                "TARGET",
                "--ttl",
                "300",
            ],
            vec![
                "dev-browser",
                "session",
                "renew",
                "--session",
                "opaque",
                "--ttl",
                "60",
            ],
            vec!["dev-browser", "session", "close", "--session", "opaque"],
        ] {
            Cli::try_parse_from(args).unwrap();
        }

        let opened =
            Cli::try_parse_from(["dev-browser", "session", "open", "--page", "TARGET"]).unwrap();
        assert!(matches!(
            opened.command,
            Some(Command::Session(SessionCommand::Open { ttl: 300, .. }))
        ));
        assert!(Cli::try_parse_from([
            "dev-browser",
            "session",
            "open",
            "--page",
            "TARGET",
            "--ttl",
            "0"
        ])
        .is_err());
    }

    #[test]
    fn rejects_ambiguous_clicks() {
        let parsed = Cli::try_parse_from(["dev-browser", "click", "--page", "main"]);
        assert!(parsed.is_err());

        let parsed = Cli::try_parse_from([
            "dev-browser",
            "click",
            "--page",
            "main",
            "--ref",
            "R1",
            "--xy",
            "1,2",
        ]);
        assert!(parsed.is_err());
    }

    #[test]
    fn preserves_script_commands() {
        let parsed =
            Cli::try_parse_from(["dev-browser", "--session", "opaque", "run", "script.js"])
                .unwrap();
        assert_eq!(parsed.session.as_deref(), Some("opaque"));
        assert!(matches!(parsed.command, Some(Command::Run { .. })));

        let request = build_execute_request(
            "execute-1".to_string(),
            "default",
            "await browser.listPages()".to_string(),
            30_000,
            Some("opaque"),
        );
        assert_eq!(request["session"], "opaque");
    }

    #[test]
    fn parses_every_interaction_primitive_and_enforces_exclusivity() {
        for args in [
            vec!["dev-browser", "focus", "--ref", "R1"],
            vec!["dev-browser", "press", "--ref", "R1", "--key", "Enter"],
            vec!["dev-browser", "paste", "--ref", "R1", "--text-stdin"],
            vec!["dev-browser", "scroll", "--ref", "R1"],
            vec![
                "dev-browser",
                "scroll",
                "--delta-y",
                "600",
                "--delta-x",
                "-10",
            ],
            vec![
                "dev-browser",
                "scroll",
                "--direction",
                "down",
                "--pages",
                "2",
            ],
            vec![
                "dev-browser",
                "scroll",
                "--until",
                "text:Done",
                "--max-steps",
                "50",
            ],
            vec!["dev-browser", "select", "--ref", "R1", "--value", "ci"],
            vec!["dev-browser", "select", "--ref", "R1", "--label", "Nigeria"],
            vec!["dev-browser", "check", "--ref", "R1"],
            vec!["dev-browser", "uncheck", "--ref", "R1"],
            vec!["dev-browser", "hover", "--ref", "R1"],
            vec!["dev-browser", "drag", "--from", "R1", "--to", "R2"],
        ] {
            Cli::try_parse_from(args).unwrap();
        }
        for args in [
            vec!["dev-browser", "paste", "--ref", "R1"],
            vec![
                "dev-browser",
                "paste",
                "--ref",
                "R1",
                "--text-stdin",
                "--shot",
            ],
            vec![
                "dev-browser",
                "paste",
                "--ref",
                "R1",
                "--text-stdin",
                "--annotate",
            ],
            vec![
                "dev-browser",
                "select",
                "--ref",
                "R1",
                "--value",
                "ci",
                "--label",
                "CI",
            ],
            vec![
                "dev-browser",
                "scroll",
                "--until",
                "text:Done",
                "--max-steps",
                "51",
            ],
            vec!["dev-browser", "scroll", "--ref", "R1", "--delta-y", "10"],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
    }

    #[test]
    fn paste_consumes_exact_stdin_once_and_builds_only_a_paste_action() {
        let parsed =
            Cli::try_parse_from(["dev-browser", "paste", "--ref", "R7", "--text-stdin"]).unwrap();
        assert!(matches!(parsed.command, Some(Command::Paste { .. })));
        let mut stdin = std::io::Cursor::new(b"secret\nwith newline".to_vec());
        let text = read_text_stream(&mut stdin).unwrap();
        assert_eq!(text, "secret\nwith newline");
        let action =
            build_primitive_action("paste", &[("ref", json!("R7")), ("text", json!(text))]);
        assert_eq!(
            action,
            json!({ "kind": "paste", "ref": "R7", "text": "secret\nwith newline" })
        );
        assert_eq!(stdin.position(), 19);
    }

    #[test]
    fn parses_and_serializes_every_structured_find_filter() {
        let parsed = Cli::try_parse_from([
            "dev-browser",
            "find",
            "--role",
            "button",
            "--name",
            "Connect",
            "--name-mode",
            "contains",
            "--within",
            "main",
            "--near",
            "Profile",
            "--frame",
            "F0",
            "--scope",
            "document",
            "--state",
            "enabled",
            "--state",
            "collapsed",
            "--index",
            "1",
            "--limit",
            "5",
        ])
        .unwrap();
        assert!(
            matches!(parsed.command, Some(Command::Find { ref role, ref name, ref states, index: Some(1), .. }) if role.as_deref() == Some("button") && name.as_deref() == Some("Connect") && states.len() == 2)
        );
        let action = build_find_action(
            None,
            Some("button"),
            Some("Connect"),
            "contains",
            Some("main"),
            Some("Profile"),
            Some("F0"),
            "document",
            &["enabled", "collapsed"],
            Some(1),
            5,
        );
        assert_eq!(
            action,
            json!({ "kind": "find", "role": "button", "name": "Connect", "nameMode": "contains", "within": "main", "near": "Profile", "frame": "F0", "scope": "document", "states": ["enabled", "collapsed"], "index": 1, "limit": 5 })
        );
        assert!(Cli::try_parse_from(["dev-browser", "find"]).is_err());
        assert!(Cli::try_parse_from(["dev-browser", "find", "--name-mode", "contains"]).is_err());
        assert!(Cli::try_parse_from([
            "dev-browser",
            "find",
            "--role",
            "button",
            "--index",
            "1000"
        ])
        .is_err());
    }
}
