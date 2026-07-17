use serde_json::{json, Value};
use std::fmt;
use std::str::FromStr;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coordinates {
    pub x: f64,
    pub y: f64,
}

impl FromStr for Coordinates {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (x, y) = value
            .split_once(',')
            .ok_or_else(|| "coordinates must use X,Y format, for example 901,631".to_string())?;
        let x = parse_coordinate(x, "x")?;
        let y = parse_coordinate(y, "y")?;
        Ok(Self { x, y })
    }
}

impl fmt::Display for Coordinates {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{},{}", self.x, self.y)
    }
}

fn parse_coordinate(value: &str, label: &str) -> Result<f64, String> {
    let parsed = value
        .trim()
        .parse::<f64>()
        .map_err(|_| format!("{label} coordinate must be a number"))?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(format!(
            "{label} coordinate must be finite and non-negative"
        ));
    }
    Ok(parsed)
}

pub struct InteractiveRequestOptions<'a> {
    pub id: String,
    pub browser: &'a str,
    pub page: &'a str,
    pub shot: Option<&'a str>,
    pub annotate: bool,
    pub full_page: bool,
    pub shot_timeout_ms: u64,
    pub connect: Option<&'a str>,
    pub headless: bool,
    pub ignore_https_errors: bool,
    pub timeout_ms: u64,
    pub session: Option<&'a str>,
    pub trace: bool,
}

pub struct ObserveActionOptions<'a> {
    pub full: bool,
    pub delta: bool,
    pub track: &'a str,
    pub max_nodes: u16,
    pub max_chars: u32,
    pub depth: u8,
    pub breadth: u16,
    pub continuation: Option<&'a str>,
    pub root: Option<&'a str>,
    pub within: Option<&'a str>,
    pub text_only: bool,
}

pub fn build_observe_action(options: ObserveActionOptions<'_>) -> Value {
    let mut action = json!({
        "kind": "observe",
        "full": options.full,
        "delta": options.delta,
        "track": options.track,
        "maxNodes": options.max_nodes,
        "maxChars": options.max_chars,
        "depth": options.depth,
        "breadth": options.breadth,
    });
    if let Some(continuation) = options.continuation {
        action["continuation"] = Value::String(continuation.to_string());
    }
    if let Some(root) = options.root {
        action["root"] = Value::String(root.to_string());
    }
    if let Some(within) = options.within {
        action["within"] = Value::String(within.to_string());
    }
    if options.text_only {
        action["textOnly"] = Value::Bool(true);
    }
    action
}

pub fn build_content_scope_action(kind: &str, ref_id: Option<&str>, within: Option<&str>) -> Value {
    let mut action = json!({ "kind": kind });
    if let Some(ref_id) = ref_id {
        action["ref"] = Value::String(ref_id.to_string());
    }
    if let Some(within) = within {
        action["within"] = Value::String(within.to_string());
    }
    action
}

pub fn apply_state_guard(action: &mut Value, from_state: Option<&str>, strict_state: bool) {
    if let Some(from_state) = from_state {
        action["fromState"] = Value::String(from_state.to_string());
    }
    if strict_state {
        action["strictState"] = Value::Bool(true);
    }
}

pub fn build_primitive_action(kind: &str, fields: &[(&str, Value)]) -> Value {
    let mut action = json!({ "kind": kind });
    for (name, value) in fields {
        action[*name] = value.clone();
    }
    action
}

pub fn build_interactive_request(options: InteractiveRequestOptions<'_>, action: Value) -> Value {
    let mut request = json!({
        "id": options.id,
        "type": "interactive",
        "protocolVersion": 2,
        "browser": options.browser,
        "page": options.page,
        "action": action,
        "timeoutMs": options.timeout_ms,
    });

    if let Some(shot) = options.shot {
        request["shot"] = Value::String(shot.to_string());
    }
    if options.annotate {
        request["annotate"] = Value::Bool(true);
    }
    if options.full_page {
        request["fullPage"] = Value::Bool(true);
    }
    request["shotTimeoutMs"] = Value::Number(options.shot_timeout_ms.into());
    if let Some(connect) = options.connect {
        request["connect"] = Value::String(connect.to_string());
    }
    if options.headless {
        request["headless"] = Value::Bool(true);
    }
    if options.ignore_https_errors {
        request["ignoreHTTPSErrors"] = Value::Bool(true);
    }
    if let Some(session) = options.session {
        request["session"] = Value::String(session.to_string());
    }
    if options.trace {
        request["trace"] = Value::Bool(true);
    }

    request
}

#[cfg(test)]
mod tests {
    use super::{
        apply_state_guard, build_content_scope_action, build_interactive_request,
        build_observe_action, build_primitive_action, Coordinates, InteractiveRequestOptions,
        ObserveActionOptions,
    };
    use serde_json::json;

    #[test]
    fn parses_non_negative_coordinates() {
        assert_eq!(
            "901,631".parse::<Coordinates>().unwrap(),
            Coordinates { x: 901.0, y: 631.0 }
        );
        assert!("901".parse::<Coordinates>().is_err());
        assert!("-1,20".parse::<Coordinates>().is_err());
        assert!("NaN,20".parse::<Coordinates>().is_err());
    }

    #[test]
    fn builds_an_interactive_request_with_connection_and_screenshot() {
        let request = build_interactive_request(
            InteractiveRequestOptions {
                id: "interactive-1".to_string(),
                browser: "daily",
                page: "TARGET",
                shot: Some("state.png"),
                annotate: true,
                full_page: true,
                shot_timeout_ms: 8_000,
                connect: Some("auto"),
                headless: false,
                ignore_https_errors: false,
                timeout_ms: 15_000,
                session: Some("opaque-session"),
                trace: true,
            },
            json!({ "kind": "read", "limit": 100, "depth": 12 }),
        );

        assert_eq!(request["type"], "interactive");
        assert_eq!(request["protocolVersion"], 2);
        assert_eq!(request["browser"], "daily");
        assert_eq!(request["page"], "TARGET");
        assert_eq!(request["connect"], "auto");
        assert_eq!(request["shot"], "state.png");
        assert_eq!(request["annotate"], true);
        assert_eq!(request["fullPage"], true);
        assert_eq!(request["shotTimeoutMs"], 8_000);
        assert_eq!(request["action"]["kind"], "read");
        assert_eq!(request["session"], "opaque-session");
        assert_eq!(request["trace"], true);
    }

    #[test]
    fn builds_observe_json_with_every_perception_flag() {
        let action = build_observe_action(ObserveActionOptions {
            full: true,
            delta: true,
            track: "checkout",
            max_nodes: 999,
            max_chars: 99_999,
            depth: 49,
            breadth: 499,
            continuation: Some("eyJ2IjoxLCJvZmZzZXQiOjN9"),
            root: None,
            within: None,
            text_only: false,
        });

        assert_eq!(
            action,
            json!({
                "kind": "observe",
                "full": true,
                "delta": true,
                "track": "checkout",
                "maxNodes": 999,
                "maxChars": 99_999,
                "depth": 49,
                "breadth": 499,
                "continuation": "eyJ2IjoxLCJvZmZzZXQiOjN9",
            })
        );
    }

    #[test]
    fn builds_observe_json_with_a_content_scope() {
        let action = build_observe_action(ObserveActionOptions {
            full: false,
            delta: false,
            track: "default",
            max_nodes: 300,
            max_chars: 12_000,
            depth: 12,
            breadth: 50,
            continuation: None,
            root: None,
            within: Some("main"),
            text_only: true,
        });

        assert_eq!(action["within"], "main");
        assert_eq!(action["textOnly"], true);
        assert!(action.get("root").is_none());
    }

    #[test]
    fn builds_content_scope_actions_for_text_and_assert() {
        let text_action = build_content_scope_action("text", Some("R42"), None);
        assert_eq!(text_action, json!({ "kind": "text", "ref": "R42" }));

        let within_action = build_content_scope_action("assert", None, Some("main"));
        assert_eq!(within_action, json!({ "kind": "assert", "within": "main" }));
    }

    #[test]
    fn legacy_read_still_uses_the_v2_request_envelope() {
        let request = build_interactive_request(
            InteractiveRequestOptions {
                id: "read-1".to_string(),
                browser: "default",
                page: "main",
                shot: None,
                annotate: false,
                full_page: false,
                shot_timeout_ms: 8_000,
                connect: None,
                headless: false,
                ignore_https_errors: false,
                timeout_ms: 10_000,
                session: None,
                trace: false,
            },
            json!({ "kind": "read", "limit": 100, "depth": 12 }),
        );

        assert_eq!(request["protocolVersion"], 2);
        assert_eq!(request["action"]["kind"], "read");
    }

    #[test]
    fn adds_state_guards_to_trusted_actions() {
        let mut action = json!({ "kind": "click", "ref": "R7" });
        apply_state_guard(&mut action, Some("doc-4:9"), true);
        assert_eq!(action["fromState"], "doc-4:9");
        assert_eq!(action["strictState"], true);
    }

    #[test]
    fn builds_json_for_every_interaction_primitive_without_echo_helpers() {
        let cases = [
            ("focus", vec![("ref", json!("R1"))]),
            ("press", vec![("ref", json!("R1")), ("key", json!("Enter"))]),
            (
                "paste",
                vec![("ref", json!("R1")), ("text", json!("secret"))],
            ),
            (
                "scroll",
                vec![("deltaY", json!(600)), ("deltaX", json!(-10))],
            ),
            (
                "select",
                vec![("ref", json!("R1")), ("label", json!("Nigeria"))],
            ),
            ("check", vec![("ref", json!("R1"))]),
            ("uncheck", vec![("ref", json!("R1"))]),
            ("hover", vec![("ref", json!("R1"))]),
            ("drag", vec![("from", json!("R1")), ("to", json!("R2"))]),
        ];
        for (kind, fields) in cases {
            let action = build_primitive_action(kind, &fields);
            assert_eq!(action["kind"], kind);
            for (name, value) in fields {
                assert_eq!(action[name], value);
            }
        }
    }
}
