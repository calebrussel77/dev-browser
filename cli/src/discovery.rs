use serde_json::{json, Value};

pub const DISCOVERY_SCHEMA_VERSION: u64 = 1;

pub fn agent_schema() -> Value {
    json!({
        "schemaVersion": DISCOVERY_SCHEMA_VERSION,
        "protocolVersions": [1, 2],
        "commands": [
            "run", "pages", "navigate", "back", "forward", "reload", "read", "observe",
            "find", "click", "focus", "press", "paste", "scroll", "select", "check",
            "uncheck", "hover", "drag", "type", "confirm", "shot", "upload",
            "session", "browsers", "install", "status", "stop", "doctor", "schema",
            "capabilities", "examples", "install-skill"
        ],
        "interactiveActions": [
            "pages", "navigate", "back", "forward", "reload", "read", "observe", "find",
            "click", "focus", "press", "paste", "scroll", "select", "check", "uncheck",
            "hover", "drag", "type", "confirm", "shot", "upload"
        ],
        "state": {
            "refFormats": ["R#", "F#:R#"],
            "stateFormat": "doc-#:revision",
            "coordinateSpace": "CSS pixels",
            "leases": true
        },
        "errors": {
            "actionability": { "exitStatus": 3, "codes": ["STALE_REF", "STALE_STATE", "AMBIGUOUS_TARGET", "TARGET_MISSING", "TARGET_HIDDEN", "TARGET_OBSCURED", "TARGET_DISABLED", "UNSUPPORTED_CONTEXT"] },
            "wait": { "exitStatus": 4, "codes": ["WAIT_TIMEOUT"] },
            "lease": { "exitStatus": 5, "codes": ["LEASE_CONFLICT"] },
            "runtime": { "exitStatus": 6, "codes": ["CDP_DISCOVERY_FAILED", "CDP_ATTACH_FAILED", "RENDERER_UNRESPONSIVE", "DAEMON_VERSION_MISMATCH", "PROTOCOL_VERSION_MISMATCH", "PAGE_CLOSED", "FRAME_DETACHED", "POPUP_OPENED"] },
            "download": { "exitStatus": 7, "codes": ["DOWNLOAD_FAILED"] },
            "confirmation": { "exitStatus": 8, "codes": ["CONFIRMATION_INVALID"] }
        },
        "limits": {
            "waitConditions": 20,
            "waitTimeoutMs": 120000,
            "observeMaxNodes": 1000,
            "observeMaxChars": 100000,
            "findMatches": 50,
            "refLength": 32,
            "confirmationTokenSeconds": 30
        },
        "diagnostics": {
            "exitStatus": { "healthyOrWarnings": 0, "invalidUsage": 2, "runtimeFailure": 6 },
            "codes": ["DAEMON_NOT_RUNNING", "DAEMON_VERSION_MISMATCH", "DAEMON_HANDSHAKE_UNSUPPORTED", "DAEMON_START_FAILED", "CDP_DISCOVERY_OR_ATTACH_FAILED", "CDP_NO_TARGETS", "RENDERER_ATTACH_FAILED"]
        },
        "security": {
            "confirmationTokens": { "scoped": true, "singleUse": true, "expiring": true },
            "boundedRedaction": true,
            "trustedInput": true
        }
    })
}

pub fn compact_capabilities() -> Value {
    json!({
        "schemaVersion": DISCOVERY_SCHEMA_VERSION,
        "protocol": 2,
        "perception": ["observe", "delta", "refs", "annotated-screenshot", "frames", "open-shadow-dom"],
        "safety": ["state-guards", "target-fingerprints", "leases", "typed-waits", "safe-retry", "confirmation-tokens", "redaction"],
        "actions": ["click", "focus", "press", "paste", "scroll", "select", "check", "uncheck", "hover", "drag", "type", "navigation", "upload", "download"],
        "discovery": ["doctor", "schema", "capabilities", "examples"],
        "runtimeHandshake": true,
        "quickjs": true
    })
}

pub fn focused_example(command: &str) -> Option<&'static str> {
    match command {
        "observe" | "read" => Some("dev-browser observe --page TARGET --delta --annotate --shot state.png"),
        "find" => Some("dev-browser find --page TARGET --role button --name \"Save\" --within main --scope visible"),
        "click" => Some("dev-browser click --page TARGET --ref F0:R12 --from-state doc-7:184 --wait-ref F0:R12=disabled"),
        "type" => Some("dev-browser type --page TARGET --ref F0:R9 --from-state doc-7:184 --text \"hello\" --clear"),
        "confirm" => Some("dev-browser confirm --page TARGET --ref F0:R14 --expect \"Recipient\""),
        "upload" => Some("dev-browser upload --page TARGET --ref F0:R5 --file upload.bin"),
        "doctor" => Some("dev-browser doctor --connect --json"),
        "schema" => Some("dev-browser schema --json"),
        "capabilities" => Some("dev-browser capabilities --compact"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_bounded_and_exposes_stable_contracts() {
        let schema = agent_schema();
        let serialized = serde_json::to_string(&schema).unwrap();
        assert!(serialized.len() < 20_000);
        assert_eq!(schema["protocolVersions"], json!([1, 2]));
        assert_eq!(schema["errors"]["confirmation"]["exitStatus"], 8);
        assert!(schema["commands"]
            .as_array()
            .unwrap()
            .contains(&json!("doctor")));
        assert!(!schema["commands"]
            .as_array()
            .unwrap()
            .contains(&json!("wait")));
        for code in ["PAGE_CLOSED", "FRAME_DETACHED", "POPUP_OPENED"] {
            assert!(schema["errors"]["runtime"]["codes"]
                .as_array()
                .unwrap()
                .contains(&json!(code)));
        }
    }

    #[test]
    fn compact_capabilities_are_small_and_agent_oriented() {
        let capabilities = compact_capabilities();
        assert!(serde_json::to_string(&capabilities).unwrap().len() < 4_000);
        assert_eq!(capabilities["runtimeHandshake"], true);
        assert_eq!(capabilities["protocol"], 2);
    }

    #[test]
    fn focused_examples_are_deterministic_and_reject_unknown_commands() {
        assert!(focused_example("click").unwrap().contains("--from-state"));
        assert_eq!(focused_example("unknown"), None);
    }
}
