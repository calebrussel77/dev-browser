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
    pub connect: Option<&'a str>,
    pub headless: bool,
    pub ignore_https_errors: bool,
    pub timeout_ms: u64,
}

pub fn build_interactive_request(options: InteractiveRequestOptions<'_>, action: Value) -> Value {
    let mut request = json!({
        "id": options.id,
        "type": "interactive",
        "browser": options.browser,
        "page": options.page,
        "action": action,
        "timeoutMs": options.timeout_ms,
    });

    if let Some(shot) = options.shot {
        request["shot"] = Value::String(shot.to_string());
    }
    if let Some(connect) = options.connect {
        request["connect"] = Value::String(connect.to_string());
    }
    if options.headless {
        request["headless"] = Value::Bool(true);
    }
    if options.ignore_https_errors {
        request["ignoreHTTPSErrors"] = Value::Bool(true);
    }

    request
}

#[cfg(test)]
mod tests {
    use super::{build_interactive_request, Coordinates, InteractiveRequestOptions};
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
                connect: Some("auto"),
                headless: false,
                ignore_https_errors: false,
                timeout_ms: 15_000,
            },
            json!({ "kind": "read", "limit": 100, "depth": 12 }),
        );

        assert_eq!(request["type"], "interactive");
        assert_eq!(request["browser"], "daily");
        assert_eq!(request["page"], "TARGET");
        assert_eq!(request["connect"], "auto");
        assert_eq!(request["shot"], "state.png");
        assert_eq!(request["action"]["kind"], "read");
    }
}
