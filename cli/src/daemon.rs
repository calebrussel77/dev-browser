use crate::connection::connect_to_daemon;
use sha2::{Digest, Sha256};
use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, BufReader};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

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
    let mut process = Command::new(&command.program);
    process.args(&command.args);
    process.current_dir(&command.current_dir);
    process.stdin(Stdio::null());
    process.stdout(Stdio::null());
    process.stderr(Stdio::null());
    process.env("DEV_BROWSER_PROCESS_ENTRY", &command.entry_path);

    #[cfg(unix)]
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
}
