// The browser talks to this origin, Convex (HTTP + WebSocket) and the
// agent's live endpoint (terminals, logs). Their URLs differ per install, so
// the policy is built once at startup from the environment.

/// `scheme://host[:port]` reduced to the HTTP and WebSocket origins of that
/// host, as `new URL(value).host` would give it; nothing for a malformed URL.
fn origins(value: Option<&str>) -> Vec<String> {
    let Some(value) = value else { return vec![] };
    let Some((scheme, rest)) = value.trim().split_once("://") else {
        return vec![];
    };
    let scheme = scheme.to_ascii_lowercase();
    let secure = match scheme.as_str() {
        "https" | "wss" => true,
        "http" | "ws" => false,
        _ => return vec![],
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if host.is_empty() {
        return vec![];
    }
    let default_port = if secure { ":443" } else { ":80" };
    let host = host.strip_suffix(default_port).unwrap_or(&host);
    if secure {
        vec![format!("https://{host}"), format!("wss://{host}")]
    } else {
        vec![format!("http://{host}"), format!("ws://{host}")]
    }
}

pub fn content_security_policy(convex_url: Option<&str>, live_url: Option<&str>) -> String {
    let mut connect: Vec<String> = vec!["'self'".into()];
    for origin in origins(convex_url).into_iter().chain(origins(live_url)) {
        if !connect.contains(&origin) {
            connect.push(origin);
        }
    }
    // Without PANARA_CLOUD_LIVE_URL (older web service env) the live endpoint
    // is unknown; allow WebSockets rather than break terminals and logs.
    if live_url.is_none() {
        connect.push("ws:".into());
        connect.push("wss:".into());
    }
    // Uploaded avatars and logos are served by Convex, over plain HTTP on an
    // install without a domain.
    let mut img: Vec<String> = ["'self'", "data:", "blob:", "https:"]
        .map(String::from)
        .to_vec();
    img.extend(
        origins(convex_url)
            .into_iter()
            .filter(|o| o.starts_with("http:")),
    );
    let directives: [(&str, Vec<String>); 11] = [
        ("default-src", vec!["'self'".into()]),
        // The page has no inline scripts (index.html only loads files), so
        // none are allowed.
        ("script-src", vec!["'self'".into()]),
        ("style-src", vec!["'self'".into(), "'unsafe-inline'".into()]),
        ("img-src", img),
        ("font-src", vec!["'self'".into(), "data:".into()]),
        ("connect-src", connect),
        ("worker-src", vec!["'self'".into(), "blob:".into()]),
        ("object-src", vec!["'none'".into()]),
        ("base-uri", vec!["'self'".into()]),
        // Connecting GitHub posts the app manifest to github.com or to a
        // GitHub Enterprise host the admin types in, so any HTTPS target.
        ("form-action", vec!["'self'".into(), "https:".into()]),
        ("frame-ancestors", vec!["'none'".into()]),
    ];
    directives
        .iter()
        .map(|(name, values)| format!("{name} {}", values.join(" ")))
        .collect::<Vec<_>>()
        .join("; ")
}

pub const HSTS: &str = "max-age=31536000; includeSubDomains";

#[cfg(test)]
mod tests {
    use super::*;

    fn directive(policy: &str, name: &str) -> Vec<String> {
        policy
            .split("; ")
            .find(|d| d.starts_with(&format!("{name} ")))
            .map(|d| d.split(' ').skip(1).map(String::from).collect())
            .unwrap_or_default()
    }

    #[test]
    fn a_domain_install_allows_its_own_https_origin() {
        let policy = content_security_policy(
            Some("https://panel.example.com/convex"),
            Some("wss://panel.example.com"),
        );
        assert_eq!(
            directive(&policy, "connect-src"),
            [
                "'self'",
                "https://panel.example.com",
                "wss://panel.example.com"
            ]
        );
        assert_eq!(directive(&policy, "frame-ancestors"), ["'none'"]);
        assert_eq!(directive(&policy, "script-src"), ["'self'"]);
        assert!(!policy.contains("unsafe-eval"));
    }

    #[test]
    fn an_ip_install_allows_the_convex_and_live_ports() {
        let policy = content_security_policy(
            Some("http://203.0.113.5:3210"),
            Some("ws://203.0.113.5:7100"),
        );
        assert_eq!(
            directive(&policy, "connect-src"),
            [
                "'self'",
                "http://203.0.113.5:3210",
                "ws://203.0.113.5:3210",
                "http://203.0.113.5:7100",
                "ws://203.0.113.5:7100"
            ]
        );
        assert!(directive(&policy, "img-src").contains(&"http://203.0.113.5:3210".to_string()));
    }

    #[test]
    fn without_a_live_url_websockets_stay_allowed() {
        let policy = content_security_policy(Some("https://x.test/convex"), None);
        assert!(directive(&policy, "connect-src").contains(&"wss:".to_string()));
    }

    #[test]
    fn forms_may_post_to_github_but_not_over_plain_http() {
        let policy = content_security_policy(Some("https://x.test/convex"), None);
        assert_eq!(directive(&policy, "form-action"), ["'self'", "https:"]);
    }

    #[test]
    fn hosts_are_normalised_like_the_url_parser_does() {
        assert_eq!(
            origins(Some("HTTPS://Panel.Example.com:443/x")),
            ["https://panel.example.com", "wss://panel.example.com"]
        );
        assert!(origins(Some("panel.example.com")).is_empty());
        assert!(origins(Some("ftp://x")).is_empty());
    }
}
