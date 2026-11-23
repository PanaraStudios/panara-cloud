use hyper::HeaderMap;
use std::net::IpAddr;

// Must match packages/backend/convex/authLimits.ts.
pub const CLIENT_IP_HEADER: &str = "x-panara-cloud-client-ip";
pub const PROXY_SECRET_HEADER: &str = "x-panara-cloud-proxy-secret";

/// Every value of a header joined with ", ", as the Fetch API reads it.
pub fn joined(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<&str> = headers
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

/// The first comma-separated entry, trimmed; None when empty.
pub fn first(value: Option<String>) -> Option<String> {
    value
        .and_then(|v| v.split(',').next().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
}

pub fn peer_ip(peer: IpAddr) -> String {
    match peer {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => v6.to_string(),
        },
        IpAddr::V4(v4) => v4.to_string(),
    }
}

/// X-Forwarded-For as the old Node server saw it: the header when a proxy
/// (Traefik) sent one, otherwise the address of whoever connected.
pub fn forwarded_for(headers: &HeaderMap, peer: IpAddr) -> String {
    joined(headers, "x-forwarded-for").unwrap_or_else(|| peer_ip(peer))
}

/// The last X-Forwarded-For entry is the one our own reverse proxy (Traefik)
/// observed; earlier entries are whatever the client sent. Behind Cloudflare
/// that is a Cloudflare address, and on an install without a domain (the web
/// app published directly) it is the connecting address, so Convex treats it
/// as a hint for per-client limits and keeps an instance-wide limit as well.
pub fn client_ip(headers: &HeaderMap, peer: IpAddr) -> String {
    let forwarded = forwarded_for(headers, peer);
    let last = forwarded
        .rsplit(',')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !last.is_empty() {
        return last;
    }
    joined(headers, "x-real-ip")
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

/// Headers that tell Convex the client's address, proven with
/// PANARA_CLOUD_PROXY_SECRET; none without the secret.
pub fn client_ip_proof(
    headers: &HeaderMap,
    peer: IpAddr,
    secret: Option<&str>,
) -> Vec<(&'static str, String)> {
    let ip = client_ip(headers, peer);
    match secret {
        Some(secret) if !ip.is_empty() => vec![
            (PROXY_SECRET_HEADER, secret.to_string()),
            (CLIENT_IP_HEADER, ip),
        ],
        _ => vec![],
    }
}

/// A non-empty x-api-key or an `Authorization: Bearer <token>`.
pub fn has_api_key(headers: &HeaderMap) -> bool {
    let key = joined(headers, "x-api-key").is_some_and(|v| !v.trim().is_empty());
    let bearer = joined(headers, "authorization").is_some_and(|v| {
        let mut parts = v.splitn(2, char::is_whitespace);
        let scheme = parts.next().unwrap_or("");
        let token = parts.next().unwrap_or("").trim();
        scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()
    });
    key || bearer
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    fn map(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    const PEER: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 1, 7));

    #[test]
    fn the_client_is_the_last_forwarded_entry() {
        let h = map(&[("x-forwarded-for", "10.0.0.1, 203.0.113.4")]);
        assert_eq!(client_ip(&h, PEER), "203.0.113.4");
        let h = map(&[
            ("x-forwarded-for", "10.0.0.1"),
            ("x-forwarded-for", "203.0.113.9"),
        ]);
        assert_eq!(client_ip(&h, PEER), "203.0.113.9");
    }

    #[test]
    fn without_a_proxy_the_client_is_whoever_connected() {
        assert_eq!(client_ip(&HeaderMap::new(), PEER), "10.0.1.7");
        let mapped: IpAddr = "::ffff:198.51.100.2".parse().unwrap();
        assert_eq!(client_ip(&HeaderMap::new(), mapped), "198.51.100.2");
    }

    #[test]
    fn an_empty_forwarded_header_falls_back_to_x_real_ip() {
        let h = map(&[("x-forwarded-for", ""), ("x-real-ip", " 203.0.113.5 ")]);
        assert_eq!(client_ip(&h, PEER), "203.0.113.5");
    }

    #[test]
    fn the_address_goes_to_convex_only_with_the_secret() {
        let h = map(&[("x-forwarded-for", "203.0.113.4")]);
        assert_eq!(
            client_ip_proof(&h, PEER, Some("s3cret")),
            vec![
                (PROXY_SECRET_HEADER, "s3cret".to_string()),
                (CLIENT_IP_HEADER, "203.0.113.4".to_string())
            ]
        );
        assert!(client_ip_proof(&h, PEER, None).is_empty());
    }

    #[test]
    fn a_key_is_a_non_empty_x_api_key_or_a_bearer_token() {
        assert!(has_api_key(&map(&[("x-api-key", "pnr_x")])));
        assert!(has_api_key(&map(&[("authorization", "Bearer pnr_x")])));
        assert!(has_api_key(&map(&[("authorization", "bearer  pnr_x")])));
        assert!(!has_api_key(&map(&[("authorization", "Bearer ")])));
        assert!(!has_api_key(&map(&[("authorization", "Basic abc")])));
        assert!(!has_api_key(&map(&[("x-api-key", "  ")])));
        assert!(!has_api_key(&map(&[("cookie", "session=1")])));
    }
}
