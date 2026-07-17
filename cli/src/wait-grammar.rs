use clap::{Args, ValueEnum};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
pub enum WaitMode {
    #[default]
    All,
    Any,
}

impl WaitMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Any => "any",
        }
    }
}

#[derive(Args, Debug, Default)]
pub struct WaitArgs {
    #[arg(long, value_enum)]
    pub wait_mode: Option<WaitMode>,
    #[arg(long, value_name = "MILLISECONDS", value_parser = clap::value_parser!(u32).range(1..=120000))]
    pub wait_timeout: Option<u32>,
    #[arg(long, value_name = "STATE,SCOPE,MATCH,VALUE", action = clap::ArgAction::Append)]
    pub wait_text: Vec<String>,
    #[arg(long, value_name = "MATCH,VALUE", action = clap::ArgAction::Append)]
    pub wait_url: Vec<String>,
    #[arg(long, value_name = "REF,STATE[,ATTRIBUTE[,EXPECTED]]", action = clap::ArgAction::Append)]
    pub wait_ref: Vec<String>,
    #[arg(long, value_name = "OPENED|CLOSED", action = clap::ArgAction::Append)]
    pub wait_dialog: Vec<String>,
    #[arg(long, value_name = "OPENED|CLOSED", action = clap::ArgAction::Append)]
    pub wait_toast: Vec<String>,
    #[arg(long)]
    pub wait_popup: bool,
    #[arg(long)]
    pub wait_download: bool,
    #[arg(long)]
    pub wait_file_chooser: bool,
    #[arg(long, value_name = "NAVIGATION|DOCUMENT", action = clap::ArgAction::Append)]
    pub wait_navigation: Vec<String>,
    #[arg(long, value_name = "MATCH,VALUE[,METHOD[,STATUS]]", action = clap::ArgAction::Append)]
    pub wait_response: Vec<String>,
    #[arg(long, value_name = "MATCH,VALUE[,METHOD]", action = clap::ArgAction::Append)]
    pub wait_failed_request: Vec<String>,
    #[arg(long, value_name = "IDLE_MILLISECONDS", value_parser = clap::value_parser!(u32).range(1..=30000))]
    pub wait_network_idle: Option<u32>,
}

fn fields<'a>(value: &'a str, count: usize, grammar: &str) -> Result<Vec<&'a str>, String> {
    let result: Vec<_> = value.splitn(count, ',').collect();
    if result.len() < count || result.iter().any(|part| part.is_empty()) {
        return Err(format!("wait condition must use {grammar}"));
    }
    Ok(result)
}

fn match_kind(value: &str) -> Result<&str, String> {
    match value {
        "exact" | "contains" | "glob" | "safe-regex" => Ok(value),
        _ => Err("match must be exact, contains, glob, or safe-regex".into()),
    }
}

fn validate_match(kind: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 2_000 {
        return Err("wait match values must contain 1 through 2000 characters".into());
    }
    if kind == "safe-regex" {
        let unsafe_tokens = [
            "(?=", "(?!", "(?<=", "(?<!", "\\1", "\\2", ")*", ")+", "){", "}*", "}+",
        ];
        if unsafe_tokens.iter().any(|token| value.contains(token))
            || value.contains("+)+")
            || value.contains("*)+")
        {
            return Err("unsafe regular expression".into());
        }
        let mut depth = 0_i32;
        for character in value.chars() {
            if character == '(' {
                depth += 1;
            } else if character == ')' {
                depth -= 1;
                if depth < 0 {
                    return Err("invalid regular expression".into());
                }
            }
        }
        if depth != 0 {
            return Err("invalid regular expression".into());
        }
    }
    Ok(())
}

impl WaitArgs {
    pub fn build_spec(&self, legacy_wait_for: Option<&str>) -> Result<Option<Value>, String> {
        let mut conditions = Vec::new();
        if let Some(value) = legacy_wait_for {
            validate_match("contains", value)?;
            conditions.push(json!({ "kind": "text", "state": "visible", "scope": "body", "match": "contains", "value": value }));
        }
        for item in &self.wait_text {
            let parts = fields(item, 4, "STATE,SCOPE,MATCH,VALUE")?;
            if !matches!(parts[0], "visible" | "hidden") {
                return Err("text state must be visible or hidden".into());
            }
            if !matches!(parts[1], "body" | "dialog" | "toast") {
                return Err("text scope must be body, dialog, or toast".into());
            }
            let kind = match_kind(parts[2])?;
            validate_match(kind, parts[3])?;
            conditions.push(json!({ "kind": "text", "state": parts[0], "scope": parts[1], "match": kind, "value": parts[3] }));
        }
        for item in &self.wait_url {
            let parts = fields(item, 2, "MATCH,VALUE")?;
            let kind = match_kind(parts[0])?;
            validate_match(kind, parts[1])?;
            conditions.push(json!({ "kind": "url", "match": kind, "value": parts[1] }));
        }
        for item in &self.wait_ref {
            let parts: Vec<_> = item.splitn(4, ',').collect();
            if parts.len() < 2
                || !parts[0].starts_with('R')
                || !parts[0][1..]
                    .chars()
                    .all(|character| character.is_ascii_digit())
            {
                return Err("ref condition must use REF,STATE[,ATTRIBUTE[,EXPECTED]]".into());
            }
            let state = parts[1];
            if !matches!(
                state,
                "attached"
                    | "detached"
                    | "visible"
                    | "hidden"
                    | "enabled"
                    | "disabled"
                    | "valueChanged"
                    | "attributeChanged"
                    | "stateChanged"
            ) {
                return Err("invalid ref wait state".into());
            }
            if state == "attributeChanged" && parts.get(2).is_none() {
                return Err("attributeChanged requires ATTRIBUTE".into());
            }
            let mut value = json!({ "kind": "ref", "ref": parts[0], "state": state });
            if let Some(attribute) = parts.get(2) {
                if attribute.is_empty() || attribute.len() > 200 {
                    return Err("ref attribute must contain 1 through 200 characters".into());
                }
                value["attribute"] = json!(attribute);
            }
            if let Some(expected) = parts.get(3) {
                if expected.len() > 2_000 {
                    return Err("ref expected value must be at most 2000 characters".into());
                }
                value["expected"] = json!(expected);
            }
            conditions.push(value);
        }
        for (kind, values) in [("dialog", &self.wait_dialog), ("toast", &self.wait_toast)] {
            for state in values {
                if !matches!(state.as_str(), "opened" | "closed") {
                    return Err(format!("{kind} state must be opened or closed"));
                } else {
                    conditions.push(json!({ "kind": kind, "state": state }));
                }
            }
        }
        if self.wait_popup {
            conditions.push(json!({ "kind": "popup" }));
        }
        if self.wait_download {
            conditions.push(json!({ "kind": "download" }));
        }
        if self.wait_file_chooser {
            conditions.push(json!({ "kind": "fileChooser" }));
        }
        for state in &self.wait_navigation {
            if !matches!(state.as_str(), "navigation" | "document") {
                return Err("navigation must be navigation or document".into());
            }
            conditions.push(json!({ "kind": "navigation", "state": state }));
        }
        for item in &self.wait_response {
            let parts: Vec<_> = item.splitn(4, ',').collect();
            if parts.len() < 2 {
                return Err("response must use MATCH,VALUE[,METHOD[,STATUS]]".into());
            }
            let kind = match_kind(parts[0])?;
            validate_match(kind, parts[1])?;
            let mut value = json!({ "kind": "response", "match": kind, "value": parts[1] });
            if let Some(method) = parts.get(2) {
                value["method"] = json!(method.to_uppercase());
            }
            if let Some(status) = parts.get(3) {
                let status = status
                    .parse::<u16>()
                    .map_err(|_| "response status must be an integer")?;
                if !(100..=599).contains(&status) {
                    return Err("response status must be between 100 and 599".into());
                }
                value["status"] = json!(status);
            }
            conditions.push(value);
        }
        for item in &self.wait_failed_request {
            let parts: Vec<_> = item.splitn(3, ',').collect();
            if parts.len() < 2 {
                return Err("failed request must use MATCH,VALUE[,METHOD]".into());
            }
            let kind = match_kind(parts[0])?;
            validate_match(kind, parts[1])?;
            let mut value = json!({ "kind": "failedRequest", "match": kind, "value": parts[1] });
            if let Some(method) = parts.get(2) {
                value["method"] = json!(method.to_uppercase());
            }
            conditions.push(value);
        }
        if let Some(idle_ms) = self.wait_network_idle {
            conditions
                .push(json!({ "kind": "networkIdle", "specialized": true, "idleMs": idle_ms }));
        }
        if conditions.is_empty() {
            if self.wait_mode.is_some() || self.wait_timeout.is_some() {
                return Err(
                    "--wait-mode and --wait-timeout require at least one wait condition".into(),
                );
            }
            return Ok(None);
        }
        if conditions.len() > 20 {
            return Err("at most 20 wait conditions are allowed".into());
        }
        Ok(Some(
            json!({ "mode": self.wait_mode.unwrap_or_default().as_str(), "timeoutMs": self.wait_timeout.unwrap_or(5_000), "conditions": conditions }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{WaitArgs, WaitMode};

    #[test]
    fn builds_every_typed_condition_and_legacy_sugar() {
        let args = WaitArgs {
            wait_mode: Some(WaitMode::Any),
            wait_timeout: Some(1200),
            wait_text: vec!["hidden,dialog,exact,Gone".into()],
            wait_url: vec!["glob,**/done".into()],
            wait_ref: vec!["R7,attributeChanged,aria-expanded,true".into()],
            wait_dialog: vec!["opened".into()],
            wait_toast: vec!["closed".into()],
            wait_popup: true,
            wait_download: true,
            wait_file_chooser: true,
            wait_navigation: vec!["document".into()],
            wait_response: vec!["contains,/api,POST,201".into()],
            wait_failed_request: vec!["safe-regex,/fail$,GET".into()],
            wait_network_idle: Some(250),
        };
        let wait = args.build_spec(Some("Saved")).unwrap().unwrap();
        assert_eq!(wait["mode"], "any");
        assert_eq!(wait["conditions"].as_array().unwrap().len(), 13);
        assert_eq!(wait["conditions"][0]["kind"], "text");
        assert_eq!(wait["conditions"][0]["match"], "contains");
    }

    #[test]
    fn rejects_invalid_combinations_and_condition_overflow() {
        let mut args = WaitArgs::default();
        args.wait_ref.push("R1,attributeChanged".into());
        assert!(args.build_spec(None).is_err());
        let mut unsafe_regex = WaitArgs::default();
        unsafe_regex.wait_url.push("safe-regex,(a+)+$".into());
        assert!(unsafe_regex.build_spec(None).is_err());
        let mode_without_condition = WaitArgs {
            wait_mode: Some(WaitMode::Any),
            ..WaitArgs::default()
        };
        assert!(mode_without_condition.build_spec(None).is_err());
        let mut overflow = WaitArgs::default();
        overflow.wait_popup = true;
        overflow.wait_text = (0..20)
            .map(|index| format!("visible,body,contains,{index}"))
            .collect();
        assert!(overflow.build_spec(None).is_err());
    }
}
