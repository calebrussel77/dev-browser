use crate::connection::connect_to_daemon;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::env;
use std::error::Error;
use std::ffi::OsStr;
#[cfg(windows)]
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufReader};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

use crate::connection::{read_line, send_message};

const DEV_BROWSER_DIR: &str = ".dev-browser";
const EMBEDDED_DAEMON: &str = include_str!("../../daemon/dist/daemon.bundle.mjs");
const EMBEDDED_SANDBOX_CLIENT: &str = include_str!("../../daemon/dist/sandbox-client.js");
const PLAYWRIGHT_RUNTIME_VERSION: &str = "1.61.1";
const DAEMON_RUNTIME_VERSION: &str = "0.1.0";
const DAEMON_PROTOCOL_VERSION: u64 = 2;
const SANDBOX_PROTOCOL_VERSION: u64 = 1;
const EMBEDDED_PACKAGE_JSON: &str = r#"{
  "name": "dev-browser-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "playwright": "1.61.1",
    "playwright-core": "1.61.1",
    "quickjs-emscripten": "^0.32.0"
  }
}"#;

struct DaemonCommand {
    program: String,
    args: Vec<String>,
    current_dir: PathBuf,
    requires_runtime_install: bool,
    entry_path: PathBuf,
}

pub fn ensure_daemon() -> Result<(), Box<dyn Error>> {
    let command = find_daemon_command()?;
    let expected = expected_runtime(&command)?;
    if is_daemon_running() {
        match probe_daemon(&expected)? {
            RuntimeProbe::Compatible => return Ok(()),
            RuntimeProbe::Mismatch {
                process_hash,
                reasons,
            } => {
                request_idle_restart(&process_hash).map_err(|error| {
                    format!(
                        "DAEMON_VERSION_MISMATCH: {}. Automatic restart was not safe: {error}",
                        reasons.join(", ")
                    )
                })?;
                if let Some(pid) = daemon_pid() {
                    wait_for_daemon_exit(pid, Duration::from_secs(5))?;
                }
            }
            RuntimeProbe::Legacy(message) => {
                return Err(format!(
                    "DAEMON_VERSION_MISMATCH: the running daemon cannot prove that it is idle ({message}). Wait for active work to finish, then run `dev-browser stop` and retry."
                ).into());
            }
        }
    }

    if command.requires_runtime_install && !embedded_runtime_installed(&command.current_dir) {
        return Err(
            "Embedded daemon dependencies are missing. Run `dev-browser install` first.".into(),
        );
    }

    spawn_daemon(&command)?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
        if is_daemon_running() {
            match probe_daemon(&expected) {
                Ok(RuntimeProbe::Compatible) => return Ok(()),
                Ok(RuntimeProbe::Mismatch { reasons, .. }) => {
                    return Err(format!(
                        "Daemon restarted with an incompatible runtime: {}",
                        reasons.join(", ")
                    )
                    .into());
                }
                Ok(RuntimeProbe::Legacy(message)) => {
                    return Err(format!(
                        "Restarted daemon does not support the runtime handshake: {message}"
                    )
                    .into());
                }
                Err(_) => {}
            }
        }
    }

    Err("Daemon failed to start within 5 seconds".into())
}

pub fn ensure_daemon_extracted() -> Result<PathBuf, Box<dyn Error>> {
    let base_dir = daemon_base_dir()?;
    extract_embedded_runtime(&base_dir)
}

fn extract_embedded_runtime(base_dir: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let daemon_hash = sha256_hex(EMBEDDED_DAEMON.as_bytes());
    let runtime_dir = base_dir.join("runtime").join(&daemon_hash);
    let daemon_path = runtime_dir.join("daemon.mjs");
    let sandbox_client_path = runtime_dir.join("sandbox-client.js");
    fs::create_dir_all(&runtime_dir)?;
    sync_verified_file(&daemon_path, EMBEDDED_DAEMON.as_bytes(), &daemon_hash)?;
    sync_verified_file(
        &sandbox_client_path,
        EMBEDDED_SANDBOX_CLIENT.as_bytes(),
        &sha256_hex(EMBEDDED_SANDBOX_CLIENT.as_bytes()),
    )?;
    sync_text_file(&base_dir.join("package.json"), EMBEDDED_PACKAGE_JSON)?;
    Ok(daemon_path)
}

pub fn install_daemon_runtime() -> Result<(), Box<dyn Error>> {
    let base_dir = daemon_base_dir()?;
    ensure_daemon_extracted()?;
    run_install_command(npm_command(), &["install"], &base_dir)?;
    run_install_command(
        npm_command(),
        &["exec", "--", "playwright", "install", "chromium"],
        &base_dir,
    )?;
    Ok(())
}

pub fn is_daemon_running() -> bool {
    connect_to_daemon().is_ok()
}

pub fn current_daemon_pid() -> Option<i32> {
    daemon_pid()
}

pub fn doctor_report(
    browser: &str,
    connect: Option<&str>,
    timeout_ms: u64,
) -> Result<(serde_json::Value, i32), Box<dyn Error>> {
    let command = find_daemon_command()?;
    let expected = expected_runtime(&command)?;
    let running_before = is_daemon_running();
    let (mut runtime, mut codes, mut exit_code) = if running_before {
        classify_runtime_probe(probe_daemon(&expected)?)
    } else {
        (
            serde_json::json!({ "status": "stopped" }),
            vec![
                serde_json::json!({ "code": "DAEMON_NOT_RUNNING", "severity": "warning", "recovery": "Run any browser command to start it" }),
            ],
            0,
        )
    };

    let mut connection =
        serde_json::json!({ "requested": connect.is_some(), "status": "not-requested" });
    if let Some(endpoint) = connect {
        if let Err(error) = ensure_daemon() {
            exit_code = 6;
            codes.push(serde_json::json!({ "code": "DAEMON_START_FAILED", "severity": "error", "message": sanitize_diagnostic_message(&error.to_string()), "recovery": "dev-browser doctor --json" }));
            connection = serde_json::json!({ "requested": true, "status": "daemon-failed" });
        } else {
            let refreshed = classify_runtime_probe(probe_daemon(&expected)?);
            runtime = refreshed.0;
            codes.retain(|item| {
                !matches!(
                    item.get("code").and_then(serde_json::Value::as_str),
                    Some(
                        "DAEMON_NOT_RUNNING"
                            | "DAEMON_VERSION_MISMATCH"
                            | "DAEMON_HANDSHAKE_UNSUPPORTED"
                    )
                )
            });
            codes.extend(refreshed.1);
            exit_code = refreshed.2;
            let pages_request = serde_json::json!({
                "id": "doctor-pages", "type": "interactive", "protocolVersion": 2,
                "browser": browser, "page": "main", "connect": endpoint,
                "timeoutMs": timeout_ms, "action": { "kind": "pages" }
            });
            match exchange_result(pages_request) {
                Ok(result) => {
                    let pages = result
                        .get("pages")
                        .and_then(serde_json::Value::as_array)
                        .into_iter()
                        .flatten()
                        .take(20)
                        .map(bounded_target)
                        .collect::<Vec<_>>();
                    let attach = if let Some(target) = pages
                        .first()
                        .and_then(|page| page.get("id"))
                        .and_then(serde_json::Value::as_str)
                    {
                        let request = serde_json::json!({
                            "id": "doctor-attach", "type": "interactive", "protocolVersion": 2,
                            "browser": browser, "page": target, "connect": endpoint,
                            "timeoutMs": timeout_ms, "action": { "kind": "read", "limit": 1, "depth": 1 }
                        });
                        match exchange_result(request) {
                            Ok(_) => {
                                serde_json::json!({ "status": "ok", "target": "first-selective-target" })
                            }
                            Err(error) => {
                                exit_code = 6;
                                codes.push(serde_json::json!({ "code": "RENDERER_ATTACH_FAILED", "severity": "error", "message": sanitize_diagnostic_message(&error.to_string()), "recovery": "Retry with --timeout 10 or a different target" }));
                                serde_json::json!({ "status": "renderer-failed" })
                            }
                        }
                    } else {
                        codes.push(serde_json::json!({ "code": "CDP_NO_TARGETS", "severity": "warning", "recovery": "Open a normal Chrome tab and retry" }));
                        serde_json::json!({ "status": "skipped", "reason": "no-targets" })
                    };
                    connection = serde_json::json!({
                        "requested": true, "status": "browser-reachable", "transport": "CDP",
                        "targetCount": pages.len(), "targets": pages, "attach": attach
                    });
                }
                Err(error) => {
                    exit_code = 6;
                    codes.push(serde_json::json!({ "code": "CDP_DISCOVERY_OR_ATTACH_FAILED", "severity": "error", "message": sanitize_diagnostic_message(&error.to_string()), "recovery": "Enable Chrome remote debugging or pass the exact CDP URL" }));
                    connection =
                        serde_json::json!({ "requested": true, "status": "browser-failed" });
                }
            }
        }
    }

    let extracted_hash = sha256_hex(&fs::read(&command.entry_path)?);
    let report = serde_json::json!({
        "schemaVersion": 1,
        "ok": exit_code == 0,
        "codes": codes,
        "cli": { "version": expected.cli_version, "buildHash": expected.cli_build_hash },
        "daemon": {
            "running": is_daemon_running(), "pid": daemon_pid(), "endpoint": daemon_endpoint_label(),
            "runtime": runtime, "version": DAEMON_RUNTIME_VERSION, "protocolVersion": DAEMON_PROTOCOL_VERSION,
            "embeddedBundleHash": expected.embedded_daemon_hash,
            "selectedEntryHash": expected.expected_daemon_hash,
            "extractedHash": extracted_hash,
            "hashParity": extracted_hash == expected.expected_daemon_hash
        },
        "playwright": {
            "expectedVersion": PLAYWRIGHT_RUNTIME_VERSION,
            "installedVersion": dependency_version(&command.current_dir, "playwright"),
            "browserAvailable": playwright_browser_available(&command.current_dir)
        },
        "quickjs": {
            "installedVersion": dependency_version(&command.current_dir, "quickjs-emscripten"),
            "sandboxProtocolVersion": SANDBOX_PROTOCOL_VERSION
        },
        "chromeDiscovery": chrome_discovery_sources(),
        "connection": connection
    });
    Ok((report, exit_code))
}

fn classify_runtime_probe(probe: RuntimeProbe) -> (serde_json::Value, Vec<serde_json::Value>, i32) {
    match probe {
        RuntimeProbe::Compatible => (serde_json::json!({ "status": "compatible" }), vec![], 0),
        RuntimeProbe::Mismatch { reasons, .. } => (
            serde_json::json!({ "status": "mismatch", "reasons": reasons }),
            vec![
                serde_json::json!({ "code": "DAEMON_VERSION_MISMATCH", "severity": "error", "recovery": "Retry a normal command to coordinate an idle restart" }),
            ],
            6,
        ),
        RuntimeProbe::Legacy(message) => (
            serde_json::json!({ "status": "legacy", "message": sanitize_diagnostic_message(&message) }),
            vec![
                serde_json::json!({ "code": "DAEMON_HANDSHAKE_UNSUPPORTED", "severity": "error", "recovery": "Wait for active work, then run dev-browser stop" }),
            ],
            6,
        ),
    }
}

fn bounded_target(target: &serde_json::Value) -> serde_json::Value {
    let mut secrets = Vec::new();
    let url = target
        .get("url")
        .and_then(serde_json::Value::as_str)
        .map(|value| sanitize_url(value, &mut secrets));
    let bounded = |key: &str, limit: usize| {
        target
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(|value| {
                redact_text(value, &secrets)
                    .chars()
                    .take(limit)
                    .collect::<String>()
            })
    };
    serde_json::json!({
        "id": bounded("id", 200),
        "url": url.map(|value| value.chars().take(500).collect::<String>()),
        "title": bounded("title", 500),
        "name": bounded("name", 200),
    })
}

fn sanitize_diagnostic_message(message: &str) -> String {
    redact_text(message, &[]).chars().take(4_000).collect()
}

fn sanitize_url(raw: &str, secrets: &mut Vec<String>) -> String {
    if raw.starts_with("ws://") || raw.starts_with("wss://") {
        return "ws://[redacted-endpoint]".to_string();
    }
    collect_raw_url_secrets(raw, secrets);
    let Ok(mut url) = Url::parse(raw) else {
        return raw.to_string();
    };
    if !url.username().is_empty() {
        add_secret(secrets, url.username());
        let _ = url.set_username("[redacted]");
    }
    if let Some(password) = url.password().filter(|value| !value.is_empty()) {
        let password = password.to_string();
        add_secret(secrets, &password);
        let _ = url.set_password(Some("[redacted]"));
    }
    let query = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if !query.is_empty() {
        url.set_query(None);
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            if sensitive_parameter(&key) {
                add_secret(secrets, &value);
                pairs.append_pair(&key, "[redacted]");
            } else {
                pairs.append_pair(&key, &value);
            }
        }
    }
    if let Some(fragment) = url.fragment().map(str::to_string) {
        let pairs = url::form_urlencoded::parse(fragment.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        if pairs.iter().any(|(key, _)| sensitive_parameter(key)) {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for (key, value) in pairs {
                if sensitive_parameter(&key) {
                    add_secret(secrets, &value);
                    serializer.append_pair(&key, "[redacted]");
                } else {
                    serializer.append_pair(&key, &value);
                }
            }
            url.set_fragment(Some(&serializer.finish()));
        }
    }
    url.to_string()
}

fn redact_text(raw: &str, secrets: &[String]) -> String {
    let mut discovered = secrets.to_vec();
    let mut value = url_regex()
        .replace_all(raw, |captures: &regex::Captures<'_>| {
            sanitize_url(&captures[0], &mut discovered)
        })
        .into_owned();
    for secret in &discovered {
        if secret.len() >= 3 {
            value = value.replace(secret, "[redacted]");
            let encoded =
                url::form_urlencoded::byte_serialize(secret.as_bytes()).collect::<String>();
            value = value.replace(&encoded, "[redacted]");
            value = value.replace(&encoded.to_ascii_lowercase(), "[redacted]");
        }
    }
    value = bearer_regex()
        .replace_all(&value, "$1 [redacted]")
        .into_owned();
    value = jwt_regex().replace_all(&value, "[redacted]").into_owned();
    value = api_key_regex()
        .replace_all(&value, "[redacted]")
        .into_owned();
    value = aws_key_regex()
        .replace_all(&value, "[redacted]")
        .into_owned();
    value = cookie_regex()
        .replace_all(&value, "$1=[redacted]")
        .into_owned();
    key_value_regex()
        .replace_all(&value, "$1=[redacted]")
        .into_owned()
}

fn sensitive_parameter(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "token"
            | "access_token"
            | "refresh_token"
            | "id_token"
            | "code"
            | "key"
            | "api_key"
            | "secret"
            | "password"
            | "signature"
            | "session"
            | "credential"
    )
}

fn decoded_component(value: &str) -> String {
    url::form_urlencoded::parse(format!("v={value}").as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| value.to_string())
}

fn add_secret(secrets: &mut Vec<String>, value: &str) {
    for candidate in [value.to_string(), decoded_component(value)] {
        if candidate.len() >= 3 && !secrets.contains(&candidate) && secrets.len() < 2_000 {
            secrets.push(candidate.chars().take(8_000).collect());
        }
    }
}

fn collect_raw_url_secrets(raw: &str, secrets: &mut Vec<String>) {
    for segment in raw.split(['?', '#']).skip(1) {
        for pair in segment.split('&') {
            if let Some((key, value)) = pair.split_once('=') {
                if sensitive_parameter(&decoded_component(key)) {
                    add_secret(secrets, value.trim_end_matches(')'));
                }
            }
        }
    }
}

fn compiled_regex(slot: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    slot.get_or_init(|| Regex::new(pattern).expect("valid diagnostic redaction regex"))
}

fn url_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    compiled_regex(&VALUE, r#"(?i)(?:https?|wss?)://[^\s\"'<>]+"#)
}
fn bearer_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    compiled_regex(&VALUE, r"(?i)\b(Bearer|Basic)\s+[^\s,;]+")
}
fn jwt_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    compiled_regex(
        &VALUE,
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
    )
}
fn api_key_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    compiled_regex(
        &VALUE,
        r"(?i)\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b",
    )
}
fn aws_key_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    compiled_regex(&VALUE, r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")
}
fn cookie_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    compiled_regex(
        &VALUE,
        r"(?i)\b(cookie|set-cookie|authorization|proxy-authorization)\s*[:=]\s*[^\r\n|]+",
    )
}
fn key_value_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    compiled_regex(
        &VALUE,
        r"(?i)\b(token|access_token|refresh_token|id_token|code|key|secret|password|signature|session)\s*[:=]\s*[^\s,;|]+",
    )
}

pub fn wait_for_daemon_exit(pid: i32, timeout: Duration) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if daemon_has_exited(pid, connect_to_daemon().is_err()) {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(100));
    }

    Err(format!("Daemon failed to stop within {} seconds", timeout.as_secs()).into())
}

fn daemon_has_exited(_pid: i32, daemon_unreachable: bool) -> bool {
    daemon_unreachable
}

fn spawn_daemon(command: &DaemonCommand) -> io::Result<()> {
    #[cfg(windows)]
    return spawn_windows_daemon(command);

    #[cfg(unix)]
    {
        let mut process = Command::new(&command.program);
        process.args(&command.args);
        process.current_dir(&command.current_dir);
        process.stdin(Stdio::null());
        process.stdout(Stdio::null());
        process.stderr(Stdio::null());
        process.env("DEV_BROWSER_PROCESS_ENTRY", &command.entry_path);

        unsafe {
            process.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let _child = process.spawn()?;
        Ok(())
    }
}

#[cfg(windows)]
fn windows_daemon_creation_flags() -> u32 {
    // CREATE_BREAKAWAY_FROM_JOB keeps agent/CI process supervisors from
    // treating the long-lived daemon as part of the one-shot CLI command.
    // CREATE_NO_WINDOW and CREATE_NEW_PROCESS_GROUP also isolate it from the
    // caller's console and control signals without leaving a console handle
    // for output-capturing shells to follow.
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;

    CREATE_BREAKAWAY_FROM_JOB
        | CREATE_NO_WINDOW
        | CREATE_NEW_PROCESS_GROUP
        | CREATE_UNICODE_ENVIRONMENT
}

#[cfg(windows)]
fn spawn_windows_daemon(command: &DaemonCommand) -> io::Result<()> {
    use std::mem::size_of;
    use std::ptr::null;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
    };

    let mut command_line = windows_command_line(&command.program, &command.args);
    let current_dir = windows_wide_null(command.current_dir.as_os_str());
    let mut environment = windows_environment_block(
        OsStr::new("DEV_BROWSER_PROCESS_ENTRY"),
        command.entry_path.as_os_str(),
    );
    let mut startup_info: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup_info.cb = size_of::<STARTUPINFOW>() as u32;
    let mut process_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    // No daemon handle may be inherited from a one-shot CLI invocation. In
    // particular, output-capturing agent runners keep waiting while any child
    // owns their internal pipeline handle, even when stdout/stderr are NUL.
    let created = unsafe {
        CreateProcessW(
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            0,
            windows_daemon_creation_flags(),
            environment.as_mut_ptr().cast(),
            current_dir.as_ptr(),
            &mut startup_info,
            &mut process_info,
        )
    };

    if created == 0 {
        return Err(io::Error::last_os_error());
    }

    unsafe {
        CloseHandle(process_info.hThread);
        CloseHandle(process_info.hProcess);
    }
    Ok(())
}

#[cfg(windows)]
fn windows_command_line(program: &str, args: &[String]) -> Vec<u16> {
    let mut command_line = Vec::new();
    for argument in std::iter::once(OsStr::new(program)).chain(args.iter().map(OsStr::new)) {
        if !command_line.is_empty() {
            command_line.push(b' ' as u16);
        }
        append_windows_quoted_argument(&mut command_line, argument);
    }
    command_line.push(0);
    command_line
}

#[cfg(windows)]
fn append_windows_quoted_argument(output: &mut Vec<u16>, argument: &OsStr) {
    let units: Vec<u16> = argument.encode_wide().collect();
    let needs_quotes = units.is_empty()
        || units
            .iter()
            .any(|unit| *unit == b' ' as u16 || *unit == b'\t' as u16 || *unit == b'"' as u16);
    if !needs_quotes {
        output.extend(units);
        return;
    }

    output.push(b'"' as u16);
    let mut backslashes = 0;
    for unit in units {
        if unit == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
        } else {
            output.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
        }
        backslashes = 0;
        output.push(unit);
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    output.push(b'"' as u16);
}

#[cfg(windows)]
fn windows_environment_block(override_key: &OsStr, override_value: &OsStr) -> Vec<u16> {
    let override_name = override_key.to_string_lossy();
    let mut variables: Vec<(OsString, OsString)> = env::vars_os()
        .filter(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case(&override_name))
        .collect();
    variables.push((override_key.to_os_string(), override_value.to_os_string()));
    variables.sort_by_key(|(key, _)| key.to_string_lossy().to_ascii_lowercase());

    let mut block = Vec::new();
    for (key, value) in variables {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

#[cfg(windows)]
fn windows_wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn daemon_pid() -> Option<i32> {
    let pid_path = dirs::home_dir()?.join(".dev-browser").join("daemon.pid");
    let pid = fs::read_to_string(pid_path).ok()?;
    pid.trim().parse::<i32>().ok()
}

fn find_daemon_command() -> Result<DaemonCommand, Box<dyn Error>> {
    if let Some(entry) = env::var_os("DEV_BROWSER_DAEMON") {
        return command_from_entry(PathBuf::from(entry));
    }

    let daemon_path = ensure_daemon_extracted()?;
    Ok(DaemonCommand {
        program: "node".to_string(),
        args: vec![daemon_path.to_string_lossy().into_owned()],
        current_dir: daemon_base_dir()?,
        requires_runtime_install: true,
        entry_path: daemon_path,
    })
}

fn command_from_entry(entry: PathBuf) -> Result<DaemonCommand, Box<dyn Error>> {
    let entry = child_process_path(fs::canonicalize(entry)?);
    let current_dir = entry
        .parent()
        .ok_or("Daemon entrypoint has no parent directory")?
        .to_path_buf();

    match entry.extension().and_then(OsStr::to_str) {
        Some("js") | Some("mjs") | Some("cjs") => Ok(DaemonCommand {
            program: "node".to_string(),
            args: vec![entry.to_string_lossy().into_owned()],
            current_dir,
            requires_runtime_install: false,
            entry_path: entry.clone(),
        }),
        Some("ts") | Some("mts") | Some("cts") => {
            let tsx_cli = find_tsx_cli(&entry)?;
            Ok(DaemonCommand {
                program: "node".to_string(),
                args: vec![
                    tsx_cli.to_string_lossy().into_owned(),
                    entry.to_string_lossy().into_owned(),
                ],
                current_dir,
                requires_runtime_install: false,
                entry_path: entry.clone(),
            })
        }
        _ => Ok(DaemonCommand {
            program: entry.to_string_lossy().into_owned(),
            args: Vec::new(),
            current_dir,
            requires_runtime_install: false,
            entry_path: entry,
        }),
    }
}

fn child_process_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(local) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(local);
        }
    }
    path
}

fn find_tsx_cli(entry: &Path) -> Result<PathBuf, Box<dyn Error>> {
    for candidate in entry.ancestors() {
        let tsx_cli = candidate
            .join("node_modules")
            .join("tsx")
            .join("dist")
            .join("cli.mjs");
        if tsx_cli.is_file() {
            return Ok(tsx_cli);
        }
    }

    Err("Could not locate the tsx runtime required to launch the TypeScript daemon.".into())
}

fn daemon_base_dir() -> Result<PathBuf, Box<dyn Error>> {
    dirs::home_dir()
        .map(|path| path.join(DEV_BROWSER_DIR))
        .ok_or_else(|| {
            "Could not determine the home directory for the embedded daemon runtime.".into()
        })
}

fn embedded_runtime_installed(base_dir: &Path) -> bool {
    dependency_installed_with_version(base_dir, "playwright", PLAYWRIGHT_RUNTIME_VERSION)
        && dependency_installed(base_dir, "quickjs-emscripten")
}

fn dependency_installed_with_version(
    base_dir: &Path,
    package_name: &str,
    expected_version: &str,
) -> bool {
    let package_json = base_dir
        .join("node_modules")
        .join(package_name)
        .join("package.json");
    let Ok(contents) = fs::read_to_string(package_json) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    manifest.get("version").and_then(|value| value.as_str()) == Some(expected_version)
}

fn dependency_installed(base_dir: &Path, package_name: &str) -> bool {
    base_dir
        .join("node_modules")
        .join(package_name)
        .join("package.json")
        .is_file()
}

fn dependency_version(base_dir: &Path, package_name: &str) -> Option<String> {
    for ancestor in base_dir.ancestors() {
        let package_json = ancestor
            .join("node_modules")
            .join(package_name)
            .join("package.json");
        let Ok(contents) = fs::read_to_string(package_json) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&contents) else {
            continue;
        };
        if let Some(version) = manifest.get("version").and_then(serde_json::Value::as_str) {
            return Some(version.to_string());
        }
    }
    None
}

fn playwright_browser_available(base_dir: &Path) -> bool {
    let mut roots = Vec::new();
    if let Some(configured) = env::var_os("PLAYWRIGHT_BROWSERS_PATH") {
        if configured != "0" {
            roots.push(PathBuf::from(configured));
        }
    }
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local.join("ms-playwright"));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".cache").join("ms-playwright"));
    }
    for ancestor in base_dir.ancestors() {
        roots.push(
            ancestor
                .join("node_modules")
                .join("playwright-core")
                .join(".local-browsers"),
        );
    }
    roots.into_iter().any(|root| {
        fs::read_dir(root).is_ok_and(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .starts_with("chromium")
            })
        })
    })
}

fn chrome_discovery_sources() -> Vec<serde_json::Value> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let candidates: Vec<(&str, PathBuf)> = if cfg!(windows) {
        vec![
            (
                "chrome-devtools-active-port",
                home.join("AppData/Local/Google/Chrome/User Data/DevToolsActivePort"),
            ),
            (
                "chromium-devtools-active-port",
                home.join("AppData/Local/Chromium/User Data/DevToolsActivePort"),
            ),
            (
                "edge-devtools-active-port",
                home.join("AppData/Local/Microsoft/Edge/User Data/DevToolsActivePort"),
            ),
        ]
    } else if cfg!(target_os = "macos") {
        vec![(
            "chrome-devtools-active-port",
            home.join("Library/Application Support/Google/Chrome/DevToolsActivePort"),
        )]
    } else {
        vec![
            (
                "chrome-devtools-active-port",
                home.join(".config/google-chrome/DevToolsActivePort"),
            ),
            (
                "chromium-devtools-active-port",
                home.join(".config/chromium/DevToolsActivePort"),
            ),
        ]
    };
    candidates
        .into_iter()
        .map(|(source, path)| serde_json::json!({ "source": source, "available": path.is_file() }))
        .collect()
}

fn daemon_endpoint_label() -> &'static str {
    if cfg!(windows) {
        "named-pipe"
    } else {
        "~/.dev-browser/daemon.sock"
    }
}

fn npm_command() -> &'static str {
    if cfg!(target_os = "windows") {
        "npm.cmd"
    } else {
        "npm"
    }
}

#[derive(Debug)]
struct ExpectedRuntime {
    cli_version: String,
    cli_build_hash: String,
    embedded_daemon_hash: String,
    expected_daemon_hash: String,
}

enum RuntimeProbe {
    Compatible,
    Mismatch {
        process_hash: String,
        reasons: Vec<String>,
    },
    Legacy(String),
}

fn sha256_hex(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
}

fn expected_runtime(command: &DaemonCommand) -> Result<ExpectedRuntime, Box<dyn Error>> {
    let embedded_daemon_hash = sha256_hex(EMBEDDED_DAEMON.as_bytes());
    let expected_daemon_hash = sha256_hex(&fs::read(&command.entry_path)?);
    let cli_version = env!("CARGO_PKG_VERSION").to_string();
    let cli_build_hash = sha256_hex(
        format!(
            "{cli_version}:{embedded_daemon_hash}:{}",
            sha256_hex(EMBEDDED_SANDBOX_CLIENT.as_bytes())
        )
        .as_bytes(),
    );
    Ok(ExpectedRuntime {
        cli_version,
        cli_build_hash,
        embedded_daemon_hash,
        expected_daemon_hash,
    })
}

fn exchange_result(message: serde_json::Value) -> Result<serde_json::Value, Box<dyn Error>> {
    let mut stream = connect_to_daemon()?;
    send_message(&mut stream, &message)?;
    let mut reader = BufReader::new(stream);
    let mut result = None;
    loop {
        let line = read_line(&mut reader)?;
        let response: serde_json::Value = serde_json::from_str(line.trim_end())?;
        match response.get("type").and_then(serde_json::Value::as_str) {
            Some("result") => result = response.get("data").cloned(),
            Some("complete") => {
                return result.ok_or_else(|| "Daemon completed without a result".into())
            }
            Some("error") => {
                let message = response
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Unknown daemon error");
                return Err(message.to_string().into());
            }
            _ => {}
        }
    }
}

fn probe_daemon(expected: &ExpectedRuntime) -> Result<RuntimeProbe, Box<dyn Error>> {
    let request = serde_json::json!({
        "id": "runtime-handshake",
        "type": "handshake",
        "cliVersion": expected.cli_version,
        "cliBuildHash": expected.cli_build_hash,
        "embeddedDaemonHash": expected.embedded_daemon_hash,
        "expectedDaemonHash": expected.expected_daemon_hash,
    });
    let data = match exchange_result(request) {
        Ok(data) => data,
        Err(error) => return Ok(RuntimeProbe::Legacy(error.to_string())),
    };
    let (process_hash, reasons) = runtime_mismatch_reasons(&data, expected);
    if reasons.is_empty() {
        Ok(RuntimeProbe::Compatible)
    } else {
        Ok(RuntimeProbe::Mismatch {
            process_hash,
            reasons,
        })
    }
}

fn runtime_mismatch_reasons(
    data: &serde_json::Value,
    expected: &ExpectedRuntime,
) -> (String, Vec<String>) {
    let process_hash = data
        .pointer("/daemon/processHash")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut reasons = Vec::new();
    let checks = [
        (
            "daemon version",
            data.pointer("/daemon/version")
                .and_then(serde_json::Value::as_str)
                == Some(DAEMON_RUNTIME_VERSION),
        ),
        (
            "daemon process hash",
            process_hash == expected.expected_daemon_hash,
        ),
        (
            "daemon protocol",
            data.pointer("/daemon/protocolVersion")
                .and_then(serde_json::Value::as_u64)
                == Some(DAEMON_PROTOCOL_VERSION),
        ),
        (
            "Playwright expected version",
            data.pointer("/playwright/expectedVersion")
                .and_then(serde_json::Value::as_str)
                == Some(PLAYWRIGHT_RUNTIME_VERSION),
        ),
        (
            "Playwright installed version",
            data.pointer("/playwright/installedVersion")
                .and_then(serde_json::Value::as_str)
                == Some(PLAYWRIGHT_RUNTIME_VERSION),
        ),
        (
            "QuickJS package",
            data.pointer("/quickjs/packageVersion")
                .and_then(serde_json::Value::as_str)
                .is_some(),
        ),
        (
            "QuickJS sandbox protocol",
            data.pointer("/quickjs/sandboxProtocolVersion")
                .and_then(serde_json::Value::as_u64)
                == Some(SANDBOX_PROTOCOL_VERSION),
        ),
        (
            "CLI version echo",
            data.pointer("/client/cliVersion")
                .and_then(serde_json::Value::as_str)
                == Some(expected.cli_version.as_str()),
        ),
        (
            "CLI build echo",
            data.pointer("/client/cliBuildHash")
                .and_then(serde_json::Value::as_str)
                == Some(expected.cli_build_hash.as_str()),
        ),
        (
            "embedded daemon echo",
            data.pointer("/client/embeddedDaemonHash")
                .and_then(serde_json::Value::as_str)
                == Some(expected.embedded_daemon_hash.as_str()),
        ),
        (
            "expected daemon echo",
            data.pointer("/client/expectedDaemonHash")
                .and_then(serde_json::Value::as_str)
                == Some(expected.expected_daemon_hash.as_str()),
        ),
        (
            "QuickJS provenance",
            data.pointer("/quickjs/provenance")
                .and_then(serde_json::Value::as_str)
                == Some("quickjs-emscripten sandbox-client"),
        ),
    ];
    for (label, compatible) in checks {
        if !compatible {
            reasons.push(label.to_string());
        }
    }
    (process_hash, reasons)
}

fn request_idle_restart(process_hash: &str) -> Result<(), Box<dyn Error>> {
    if process_hash.len() != 64 {
        return Err("running daemon did not provide a valid process hash".into());
    }
    exchange_result(serde_json::json!({
        "id": "runtime-restart",
        "type": "restart",
        "currentDaemonHash": process_hash,
        "ifIdle": true,
    }))?;
    Ok(())
}

fn sync_verified_file(
    path: &Path,
    contents: &[u8],
    expected_hash: &str,
) -> Result<(), Box<dyn Error>> {
    let valid = fs::read(path)
        .map(|existing| sha256_hex(&existing) == expected_hash)
        .unwrap_or(false);
    if !valid {
        fs::write(path, contents)?;
    }
    let actual_hash = sha256_hex(&fs::read(path)?);
    if actual_hash != expected_hash {
        return Err(format!("Extracted runtime hash mismatch for {}", path.display()).into());
    }
    Ok(())
}

fn sync_text_file(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    let needs_update = match fs::read_to_string(path) {
        Ok(existing) => existing != contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };

    if needs_update {
        fs::write(path, contents)?;
    }

    Ok(())
}

fn run_install_command(
    program: &str,
    args: &[&str],
    current_dir: &Path,
) -> Result<(), Box<dyn Error>> {
    let status = Command::new(program)
        .args(args)
        .current_dir(current_dir)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| -> Box<dyn Error> {
            match error.kind() {
                io::ErrorKind::NotFound => format!(
                    "Could not find `{program}` in PATH while setting up the embedded daemon runtime in {}. Install Node.js/npm and run `dev-browser install` again.",
                    current_dir.display()
                )
                .into(),
                _ => format!(
                    "Failed to run `{program} {}` in {}: {error}",
                    args.join(" "),
                    current_dir.display()
                )
                .into(),
            }
        })?;

    if status.success() {
        return Ok(());
    }

    let reason = match status.code() {
        Some(code) => format!(
            "`{program} {}` failed with exit code {code}",
            args.join(" ")
        ),
        None => format!("`{program} {}` terminated by signal", args.join(" ")),
    };

    Err(reason.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn expected(hash: &str) -> ExpectedRuntime {
        ExpectedRuntime {
            cli_version: "0.2.8".to_string(),
            cli_build_hash: "b".repeat(64),
            embedded_daemon_hash: "c".repeat(64),
            expected_daemon_hash: hash.to_string(),
        }
    }

    #[test]
    fn accepts_only_a_complete_compatible_runtime_handshake() {
        let hash = "a".repeat(64);
        let expected = expected(&hash);
        let data = serde_json::json!({
            "client": {
                "cliVersion": expected.cli_version,
                "cliBuildHash": expected.cli_build_hash,
                "embeddedDaemonHash": expected.embedded_daemon_hash,
                "expectedDaemonHash": expected.expected_daemon_hash,
            },
            "daemon": {
                "version": DAEMON_RUNTIME_VERSION,
                "processHash": hash,
                "protocolVersion": DAEMON_PROTOCOL_VERSION,
            },
            "playwright": {
                "expectedVersion": PLAYWRIGHT_RUNTIME_VERSION,
                "installedVersion": PLAYWRIGHT_RUNTIME_VERSION,
            },
            "quickjs": {
                "packageVersion": "0.32.1",
                "sandboxProtocolVersion": SANDBOX_PROTOCOL_VERSION,
                "provenance": "quickjs-emscripten sandbox-client",
            },
        });
        let (_, reasons) = runtime_mismatch_reasons(&data, &expected);
        assert!(reasons.is_empty(), "{reasons:?}");
    }

    #[test]
    fn reports_each_runtime_mismatch_deterministically() {
        let hash = "a".repeat(64);
        let expected = expected(&hash);
        let data = serde_json::json!({
            "client": { "cliVersion": "old", "cliBuildHash": "x", "embeddedDaemonHash": "y" },
            "daemon": { "version": "old", "processHash": "d".repeat(64), "protocolVersion": 1 },
            "playwright": { "expectedVersion": "1.58.2", "installedVersion": "1.58.2" },
            "quickjs": { "packageVersion": null, "sandboxProtocolVersion": 0 },
        });
        let (_, reasons) = runtime_mismatch_reasons(&data, &expected);
        assert_eq!(reasons.len(), 12);
        assert!(reasons.contains(&"daemon process hash".to_string()));
        assert!(reasons.contains(&"Playwright installed version".to_string()));
    }

    #[test]
    fn extraction_is_content_addressed_and_repairs_corruption() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "dev-browser-runtime-test-{}-{unique}",
            std::process::id()
        ));
        let daemon_path = extract_embedded_runtime(&base).unwrap();
        let expected_hash = sha256_hex(EMBEDDED_DAEMON.as_bytes());
        assert_eq!(
            daemon_path.parent().unwrap().file_name().unwrap(),
            expected_hash.as_str()
        );
        fs::write(&daemon_path, "corrupt").unwrap();
        assert_eq!(extract_embedded_runtime(&base).unwrap(), daemon_path);
        assert_eq!(sha256_hex(&fs::read(&daemon_path).unwrap()), expected_hash);
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn strips_verbatim_windows_paths_before_launching_node() {
        assert_eq!(
            child_process_path(PathBuf::from(r"\\?\C:\Labs\dev-browser\daemon.ts")),
            PathBuf::from(r"C:\Labs\dev-browser\daemon.ts")
        );
        assert_eq!(
            child_process_path(PathBuf::from(r"\\?\UNC\server\share\daemon.ts")),
            PathBuf::from(r"\\server\share\daemon.ts")
        );
    }

    #[cfg(windows)]
    #[test]
    fn daemon_spawn_breaks_away_from_the_callers_windows_job() {
        assert_eq!(windows_daemon_creation_flags(), 0x0900_0600);
    }

    #[cfg(windows)]
    #[test]
    fn daemon_command_line_preserves_windows_paths_with_spaces() {
        let encoded = windows_command_line(
            "node",
            &[
                r"C:\Program Files\dev-browser\daemon.mjs".to_string(),
                "plain".to_string(),
            ],
        );
        assert_eq!(
            String::from_utf16(&encoded[..encoded.len() - 1]).unwrap(),
            r#"node "C:\Program Files\dev-browser\daemon.mjs" plain"#
        );
    }

    #[test]
    fn doctor_diagnostics_bound_targets_and_redact_websocket_endpoints() {
        let secret = "doctor-secret-value";
        let target = serde_json::json!({
            "id": "x".repeat(500),
            "url": format!("https://user:{secret}@example.test/path?access_token={secret}&safe=1"),
            "title": format!("Account {secret}"),
            "name": "n".repeat(500)
        });
        let bounded = bounded_target(&target);
        assert_eq!(bounded["id"].as_str().unwrap().chars().count(), 200);
        let serialized = serde_json::to_string(&bounded).unwrap();
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("user:"));
        assert!(serialized.contains("access_token="));
        assert!(serialized.contains("redacted"));
        let message = sanitize_diagnostic_message(
            "failed at ws://127.0.0.1:9222/devtools/browser/private-token with Bearer secret-token after timeout",
        );
        assert!(!message.contains("private-token"));
        assert!(!message.contains("secret-token"));
        assert!(message.contains("ws://[redacted-endpoint]"));
    }

    #[test]
    fn doctor_redaction_matches_adversarial_daemon_policy_cases() {
        let secret = "TOP_SECRET";
        for target in [
            serde_json::json!({ "url": "https://example.test", "title": format!("token={secret}") }),
            serde_json::json!({ "url": format!("https://example.test/?access%5Ftoken={secret}"), "title": secret }),
            serde_json::json!({ "url": format!("https://user:password-secret@example.test"), "title": "password-secret" }),
        ] {
            assert!(!serde_json::to_string(&bounded_target(&target))
                .unwrap()
                .contains(secret));
        }
        let messages = [
            format!("failed (https://example.test/?access_token={secret})"),
            format!("cookie: sid={secret}"),
            "jwt eyJabcdefgh.abcdefghijk.abcdefghijk".to_string(),
            "key ghp_abcdefghijklmnop".to_string(),
        ];
        for message in messages {
            assert!(!sanitize_diagnostic_message(&message).contains(secret));
            assert!(sanitize_diagnostic_message(&message).contains("[redacted]"));
        }
    }

    #[test]
    fn doctor_runtime_mismatches_are_failures() {
        let (runtime, codes, exit_code) = classify_runtime_probe(RuntimeProbe::Mismatch {
            process_hash: "a".repeat(64),
            reasons: vec!["daemon version".to_string()],
        });
        assert_eq!(runtime["status"], "mismatch");
        assert_eq!(codes[0]["code"], "DAEMON_VERSION_MISMATCH");
        assert_eq!(exit_code, 6);

        let (runtime, codes, exit_code) =
            classify_runtime_probe(RuntimeProbe::Legacy("legacy secret".to_string()));
        assert_eq!(runtime["status"], "legacy");
        assert_eq!(codes[0]["code"], "DAEMON_HANDSHAKE_UNSUPPORTED");
        assert_eq!(exit_code, 6);
    }
}
