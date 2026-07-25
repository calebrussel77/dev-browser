use serde_json::{json, Value};

pub const DISCOVERY_SCHEMA_VERSION: u64 = 1;

pub fn agent_schema() -> Value {
    json!({
        "schemaVersion": DISCOVERY_SCHEMA_VERSION,
        "protocolVersions": [1, 2],
        "commands": [
            "run", "pages", "navigate", "back", "forward", "reload", "read", "observe",
            "find", "text", "assert", "click", "focus", "press", "paste", "scroll", "select",
            "check", "uncheck", "hover", "drag", "type", "confirm", "shot", "upload",
            "session", "browsers", "install", "status", "stop", "doctor", "schema",
            "capabilities", "examples", "trace", "video", "install-skill"
        ],
        "interactiveActions": [
            "pages", "navigate", "back", "forward", "reload", "read", "observe", "find",
            "text", "assert", "click", "focus", "press", "paste", "scroll", "select",
            "check", "uncheck", "hover", "drag", "type", "confirm", "shot", "upload"
        ],
        "state": {
            "refFormats": ["R#", "F#:R#"],
            "stateFormat": "doc-#:revision",
            "coordinateSpace": "CSS pixels",
            "leases": true
        },
        "errors": {
            "actionability": { "exitStatus": 3, "codes": ["STALE_REF", "STALE_STATE", "AMBIGUOUS_TARGET", "TARGET_MISSING", "TARGET_HIDDEN", "TARGET_OBSCURED", "TARGET_DISABLED", "UNSUPPORTED_CONTEXT", "ASSERTION_FAILED", "INPUT_VALUE_MISMATCH"] },
            "wait": { "exitStatus": 4, "codes": ["WAIT_TIMEOUT"] },
            "lease": { "exitStatus": 5, "codes": ["LEASE_CONFLICT"] },
            "runtime": { "exitStatus": 6, "codes": ["CDP_DISCOVERY_FAILED", "CDP_ATTACH_FAILED", "RENDERER_UNRESPONSIVE", "WINDOW_OCCLUDED", "DAEMON_VERSION_MISMATCH", "PROTOCOL_VERSION_MISMATCH", "PAGE_CLOSED", "FRAME_DETACHED", "POPUP_OPENED"] },
            "download": { "exitStatus": 7, "codes": ["DOWNLOAD_FAILED"] },
            "video": { "exitStatus": 6, "codes": ["VIDEO_ALREADY_RECORDING", "VIDEO_NOT_RECORDING", "VIDEO_ENCODER_MISSING"] },
            "confirmation": { "exitStatus": 8, "codes": ["CONFIRMATION_INVALID"] }
        },
        "limits": {
            "waitConditions": 20,
            "waitTimeoutMs": 120000,
            "observeMaxNodes": 1000,
            "observeMaxChars": 100000,
            "findMatches": 50,
            "refLength": 32,
            "confirmationTokenSeconds": 30,
            "shotTimeoutMsRange": "250..120000, defaults to min(timeoutMs, 8000)",
            "consoleJsonMaxBytes": 65536
        },
        "interactiveRequest": {
            "required": ["id", "type", "protocolVersion", "browser", "page", "action"],
            "optional": { "shot": "temp PNG name", "annotate": "boolean", "fullPage": "boolean", "shotTimeoutMs": "250..120000, defaults to min(timeoutMs, 8000)", "headless": "boolean", "ignoreHTTPSErrors": "boolean", "connect": "CDP URL or auto", "timeoutMs": "positive integer", "session": "lease id", "trace": "boolean" },
            "crossFieldRules": ["confirmToken requires protocolVersion 2, fromState, and a trusted ref action; click/type/scroll require their ref form", "protocolVersion 2 confirm requires both ref and expectText", "paste forbids shot and annotate"],
            "actionGrammar": {
                "pages": { "required": [], "optional": [] },
                "navigate": { "required": ["url"], "optional": ["wait"] },
                "back": { "required": [], "optional": ["fromState:doc-#:revision", "strictState:boolean", "wait"] },
                "forward": { "required": [], "optional": ["fromState:doc-#:revision", "strictState:boolean", "wait"] },
                "reload": { "required": [], "optional": ["fromState:doc-#:revision", "strictState:boolean", "wait"] },
                "read": { "required": [], "optional": ["limit:1..500", "depth:1..50"] },
                "observe": { "required": [], "optional": ["full:boolean", "delta:boolean", "track:string", "maxNodes:1..1000", "maxChars:1..100000", "depth:1..50", "breadth:1..500", "continuation:string", "root:ref (mutually exclusive with within)", "within:landmark substring (find grammar)|role:<role>|name:<exact name>", "textOnly:boolean"] },
                "find": { "atLeastOne": ["query", "role", "name", "within", "near", "frame", "states[]"], "optional": ["nameMode:exact|contains (requires name)", "scope:visible|viewport|document", "index:0..999", "limit:1..50", "scrollContainer:ref (requires maxSteps; bounded auto-scroll over a virtualized/overflow container)", "maxSteps:1..50 (requires scrollContainer)"] },
                "text": { "oneOf": [["ref"], ["within"]], "optional": ["maxChars:1..200000 (default 20000)"] },
                "assert": { "oneOf": [["ref"], ["within"]], "required": ["text"], "optional": ["match:exact|contains (default contains)"] },
                "click": { "oneOf": [["ref"], ["x>=0", "y>=0"]], "optional": ["method:mouse|locator (coordinates require mouse)", "retry:never|safe|once", "fromState", "strictState", "expectText", "waitForText", "confirmToken", "wait"] },
                "focus": { "required": ["ref"], "optional": ["fromState", "strictState", "confirmToken", "wait"] },
                "press": { "required": ["ref", "key:1..64 safe key chars"], "optional": ["fromState", "strictState", "confirmToken", "wait"] },
                "paste": { "required": ["ref", "text"], "optional": ["fromState", "strictState", "confirmToken", "wait"] },
                "scroll": { "oneOf": [["ref"], ["deltaX|deltaY:-100000..100000"], ["direction:up|down|left|right", "pages:1..50"], ["until:text:...|role:...", "maxSteps:1..50"], ["ref", "until:text:...|role:...", "maxSteps:1..50 (container-relative: scans ref as a scrollable container instead of scrolling it into view)"]], "optional": ["fromState", "strictState", "confirmToken (ref form only; requires fromState)", "wait"] },
                "select": { "required": ["ref"], "oneOf": [["value"], ["label"]], "optional": ["fromState", "strictState", "confirmToken", "wait"] },
                "check": { "required": ["ref"], "optional": ["fromState", "strictState", "confirmToken", "wait"] },
                "uncheck": { "required": ["ref"], "optional": ["fromState", "strictState", "confirmToken", "wait"] },
                "hover": { "required": ["ref"], "optional": ["fromState", "strictState", "confirmToken", "wait"] },
                "drag": { "required": ["from", "to"], "optional": ["fromState", "strictState", "confirmToken", "wait"] },
                "type": { "required": ["text"], "optional": ["ref", "clear:boolean", "delayMs:0..1000", "fromState", "strictState", "confirmToken", "wait"] },
                "upload": { "required": ["ref", "file"], "optional": ["fromState", "strictState", "confirmToken", "wait"] },
                "confirm": { "required": [], "optional": ["ref", "expectText", "fromState", "strictState"] },
                "shot": { "required": [], "optional": ["ref", "padding:0..1000", "fromState", "strictState"] }
            }
        },
        "waitGrammar": {
            "spec": { "mode": "all|any", "timeoutMs": "1..120000", "conditions": "1..20 condition objects" },
            "conditions": {
                "text": { "required": ["state:visible|hidden", "scope:body|dialog|toast", "match:exact|contains|glob|safe-regex", "value:1..2000 chars"] },
                "url": { "required": ["match:exact|contains|glob|safe-regex", "value"] },
                "ref": { "required": ["ref", "state:attached|detached|visible|hidden|enabled|disabled|valueChanged|attributeChanged|stateChanged"], "optional": ["attribute (required for attributeChanged)", "expected"] },
                "dialog": { "required": ["state:opened|closed"] },
                "toast": { "required": ["state:opened|closed"] },
                "popup": { "required": [] }, "download": { "required": [] }, "fileChooser": { "required": [] },
                "navigation": { "required": ["state:navigation|document"] },
                "response": { "required": ["match", "value"], "optional": ["method:1..20 chars", "status:100..599"] },
                "failedRequest": { "required": ["match", "value"], "optional": ["method"] },
                "networkIdle": { "required": ["specialized:true"], "optional": ["idleMs:1..30000 (default 500)"] }
            }
        },
        "responseGrammar": {
            "successRequired": ["protocolVersion:2", "ok:true", "requestId", "browser", "page", "action"],
            "commonOptional": ["documentId", "stateId", "url", "title", "tree", "elements", "coordinateSpace", "warnings", "trace"],
            "actionFields": { "observe": ["delta", "truncation", "artifacts", "scope", "textOnly"], "find": ["matches", "ambiguity", "scrollMetrics"], "text": ["scope", "textContent", "textTruncation"], "assert": ["scope", "asserted", "observed"], "click": ["clicked", "change", "attempts", "attemptJournal", "waitResult", "popup", "download"], "type": ["typed", "inputStrategy", "verifiedValue", "attemptJournal"], "navigation": ["navigation", "waitResult"], "upload": ["uploaded"], "confirm": ["confirmation", "confirmationToken"], "shot": ["artifacts", "screenshotPath"] },
            "failureRequired": ["protocolVersion:2", "ok:false", "requestId", "error.code", "error.message", "error.recoverable"],
            "failureOptional": ["browser", "page", "action", "error.details", "error.nextCommands"]
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
        "perception": ["observe", "delta", "refs", "annotated-screenshot", "frames", "open-shadow-dom", "bounded-capture", "scoped-content"],
        "safety": ["state-guards", "target-fingerprints", "leases", "typed-waits", "safe-retry", "confirmation-tokens", "redaction"],
        "actions": ["click", "focus", "press", "paste", "scroll", "select", "check", "uncheck", "hover", "drag", "type", "navigation", "upload", "download"],
        "discovery": ["doctor", "schema", "capabilities", "examples", "trace"],
        "video": ["start", "chapter", "stop"],
        "runtimeHandshake": true,
        "quickjs": true,
        "scripting": ["console.json"]
    })
}

pub fn focused_example(command: &str) -> Option<&'static str> {
    match command {
        "observe" | "read" => Some("dev-browser observe --page TARGET --delta --annotate --shot state.png"),
        "find" => Some("dev-browser find --page TARGET --role button --name \"Save\" --within main --scope visible"),
        "text" => Some("dev-browser text --page TARGET --within main"),
        "assert" => Some("dev-browser assert --page TARGET --within main --text \"Jane Doe\" --match contains"),
        "click" => Some("dev-browser click --page TARGET --ref F0:R12 --from-state doc-7:184 --wait-ref F0:R12=disabled"),
        "type" => Some("dev-browser type --page TARGET --ref F0:R9 --from-state doc-7:184 --text \"hello\" --clear"),
        "confirm" => Some("dev-browser confirm --page TARGET --ref F0:R14 --expect \"Recipient\""),
        "upload" => Some("dev-browser upload --page TARGET --ref F0:R5 --file upload.bin"),
        "doctor" => Some("dev-browser doctor --connect --json"),
        "schema" => Some("dev-browser schema --json"),
        "capabilities" => Some("dev-browser capabilities --compact"),
        "trace" => Some("dev-browser click --page TARGET --ref R7 --trace && dev-browser trace show LAST"),
        "video" => Some(concat!(
            "dev-browser video start --page TARGET recordings/flow.webm --size 1280x800\n",
            "dev-browser click --page TARGET --ref R7\n",
            "dev-browser video stop --page TARGET"
        )),
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
        assert_eq!(
            schema["interactiveRequest"]["actionGrammar"]["press"]["required"],
            json!(["ref", "key:1..64 safe key chars"])
        );
        assert_eq!(
            schema["interactiveRequest"]["actionGrammar"]["type"]["required"],
            json!(["text"])
        );
        assert_eq!(
            schema["interactiveRequest"]["actionGrammar"]["find"]["atLeastOne"],
            json!(["query", "role", "name", "within", "near", "frame", "states[]"])
        );
        let wait = &schema["waitGrammar"]["conditions"];
        assert!(wait["ref"]["required"][1]
            .as_str()
            .unwrap()
            .contains("attached|detached"));
        assert_eq!(
            wait["navigation"]["required"],
            json!(["state:navigation|document"])
        );
        assert_eq!(
            wait["networkIdle"]["optional"],
            json!(["idleMs:1..30000 (default 500)"])
        );
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

    #[test]
    fn video_recording_is_discoverable() {
        let schema = agent_schema();
        assert!(schema["commands"]
            .as_array()
            .unwrap()
            .contains(&json!("video")));
        for code in [
            "VIDEO_ALREADY_RECORDING",
            "VIDEO_NOT_RECORDING",
            "VIDEO_ENCODER_MISSING",
        ] {
            assert!(schema["errors"]["video"]["codes"]
                .as_array()
                .unwrap()
                .contains(&json!(code)));
        }
        assert_eq!(schema["errors"]["video"]["exitStatus"], 6);

        let capabilities = compact_capabilities();
        assert!(capabilities["video"]
            .as_array()
            .unwrap()
            .contains(&json!("start")));

        assert!(focused_example("video").unwrap().contains("video stop"));
    }
}
