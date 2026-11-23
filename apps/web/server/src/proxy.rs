use crate::headers::{
    CLIENT_IP_HEADER, PROXY_SECRET_HEADER, client_ip_proof, first, forwarded_for, has_api_key,
    joined,
};
use crate::{Body, full, json};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderName, HeaderValue};
use hyper::{HeaderMap, Method, Request, Response, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use std::net::IpAddr;
use std::time::Duration;

// Must match MAX_ARGS_BYTES in packages/backend/convex/platform/lib/apiGateway.ts.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

const HOP_BY_HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

#[cfg(feature = "tls")]
type Connector = hyper_rustls::HttpsConnector<HttpConnector>;
#[cfg(not(feature = "tls"))]
type Connector = HttpConnector;

/// The Convex site (HTTP actions) the /api routes are proxied to.
pub struct Upstream {
    client: Client<Connector, Full<Bytes>>,
    site: Option<String>,
    secret: Option<String>,
    port: u16,
}

fn connector() -> Connector {
    let mut http = HttpConnector::new();
    http.set_connect_timeout(Some(Duration::from_secs(10)));
    http.set_nodelay(true);
    #[cfg(feature = "tls")]
    {
        http.enforce_http(false);
        hyper_rustls::HttpsConnectorBuilder::new()
            .with_webpki_roots()
            .https_or_http()
            .enable_http1()
            .wrap_connector(http)
    }
    #[cfg(not(feature = "tls"))]
    http
}

fn no_store(mut response: Response<Body>) -> Response<Body> {
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

fn json_rpc_error(status: StatusCode, message: &str) -> Response<Body> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "error": { "code": -32000, "message": message },
        "id": null,
    });
    no_store(json(status, &body))
}

fn error(status: StatusCode, message: &str) -> Response<Body> {
    json(status, &serde_json::json!({ "error": message }))
}

async fn read_capped(mut body: Incoming, headers: &HeaderMap) -> Option<Bytes> {
    let declared = joined(headers, "content-length")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if declared > MAX_BODY_BYTES as u64 {
        drain(body);
        return None;
    }
    let mut collected = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else { return None };
        if let Ok(data) = frame.into_data() {
            if collected.len() + data.len() > MAX_BODY_BYTES {
                drain(body);
                return None;
            }
            collected.extend_from_slice(&data);
        }
    }
    Some(Bytes::from(collected))
}

/// Reads and drops the rest of a refused body while the refusal is sent:
/// closing the connection on a client still sending makes it lose the
/// answer. Bounded, so a refused upload cannot hold the connection forever.
fn drain(mut body: Incoming) {
    tokio::spawn(async move {
        let mut left: usize = 64 * 1024 * 1024;
        let reading = async {
            while let Some(Ok(frame)) = body.frame().await {
                let size = frame.data_ref().map_or(0, |d| d.len());
                if size >= left {
                    break;
                }
                left -= size;
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(30), reading).await;
    });
}

fn path_and_query(request: &Request<Incoming>) -> String {
    request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".into())
}

fn set(headers: &mut HeaderMap, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (
        HeaderName::from_bytes(name.as_bytes()),
        HeaderValue::from_str(value),
    ) {
        headers.insert(name, value);
    }
}

/// The request's headers without hop-by-hop ones, its length, its host and
/// any client-address claim it makes about itself.
fn passable(headers: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in headers {
        let lower = name.as_str();
        if HOP_BY_HOP.contains(&lower)
            || lower == "host"
            || lower == "content-length"
            || lower == CLIENT_IP_HEADER
            || lower == PROXY_SECRET_HEADER
        {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    out
}

fn passthrough(response: Response<Incoming>) -> Response<Body> {
    let (mut parts, body) = response.into_parts();
    for name in HOP_BY_HOP {
        parts.headers.remove(name);
    }
    Response::from_parts(parts, body.boxed())
}

impl Upstream {
    pub fn new(site: Option<String>, secret: Option<String>, port: u16) -> Self {
        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(30))
            .build(connector());
        Upstream {
            client,
            site: site.map(|s| s.trim_end_matches('/').to_string()),
            secret,
            port,
        }
    }

    async fn send(
        &self,
        method: Method,
        url: &str,
        headers: HeaderMap,
        body: Bytes,
    ) -> Result<Response<Incoming>, String> {
        let mut request = Request::builder()
            .method(method)
            .uri(url)
            .body(Full::new(body))
            .map_err(|e| e.to_string())?;
        *request.headers_mut() = headers;
        self.client
            .request(request)
            .await
            .map_err(|e| format!("{url}: {e}"))
    }

    fn unreachable(&self, why: String) -> Response<Body> {
        eprintln!("upstream request failed: {why}");
        error(
            StatusCode::BAD_GATEWAY,
            "The panel's backend did not answer",
        )
    }

    /// /api/auth/*: Better Auth runs in Convex; proxying keeps its cookies on
    /// this origin. Convex rate-limits sign-ins per account and client IP;
    /// the secret proves to it that the IP comes from this proxy.
    pub async fn auth(&self, request: Request<Incoming>, peer: IpAddr) -> Response<Body> {
        let Some(site) = &self.site else {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "CONVEX_INTERNAL_SITE_URL is not set",
            );
        };
        if !matches!(*request.method(), Method::GET | Method::HEAD | Method::POST) {
            return method_not_allowed("GET, HEAD, POST");
        }
        let url = format!("{site}{}", path_and_query(&request));
        let (parts, body) = request.into_parts();
        let Some(body) = read_capped(body, &parts.headers).await else {
            return error(StatusCode::PAYLOAD_TOO_LARGE, "Request larger than 4 MB");
        };
        let mut headers = passable(&parts.headers);
        headers.remove("x-forwarded-host");
        headers.remove("x-forwarded-proto");
        // What the Next.js server added before its handler forwarded the
        // request; kept so Better Auth sees the same request as before.
        if !headers.contains_key("x-forwarded-for") {
            set(
                &mut headers,
                "x-forwarded-for",
                &forwarded_for(&parts.headers, peer),
            );
        }
        if !headers.contains_key("x-forwarded-port") {
            set(&mut headers, "x-forwarded-port", &self.port.to_string());
        }
        for (name, value) in client_ip_proof(&parts.headers, peer, self.secret.as_deref()) {
            set(&mut headers, name, &value);
        }
        set(&mut headers, "accept-encoding", "application/json");
        // @convex-dev/better-auth's Next.js handler sent its own request URL,
        // which the Node server always built as localhost:<PORT>. Better Auth
        // only uses it when that origin is trusted (SITE_URL in development);
        // otherwise it falls back to the Convex site URL.
        set(
            &mut headers,
            "x-better-auth-forwarded-host",
            &format!("localhost:{}", self.port),
        );
        let proto =
            first(joined(&parts.headers, "x-forwarded-proto")).unwrap_or_else(|| "http".into());
        set(&mut headers, "x-better-auth-forwarded-proto", &proto);
        let body = if parts.method == Method::GET || parts.method == Method::HEAD {
            Bytes::new()
        } else {
            body
        };
        match self.send(parts.method, &url, headers, body).await {
            Ok(response) => passthrough(response),
            Err(why) => self.unreachable(why),
        }
    }

    /// /api/v1/*: the public API is served by Convex's HTTP router; this
    /// keeps it on the panel's own origin in both IP and domain installs.
    pub async fn api(&self, request: Request<Incoming>, peer: IpAddr) -> Response<Body> {
        let Some(site) = &self.site else {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The API is not available on this panel",
            );
        };
        let method = request.method().clone();
        if !matches!(
            method,
            Method::GET
                | Method::HEAD
                | Method::POST
                | Method::PUT
                | Method::PATCH
                | Method::DELETE
        ) {
            return method_not_allowed("DELETE, GET, HEAD, PATCH, POST, PUT");
        }
        // Nothing here works without a key, and only a key holder's body is
        // worth reading, at most the gateway's limit.
        if !has_api_key(request.headers()) {
            return no_store(error(
                StatusCode::UNAUTHORIZED,
                "Missing or malformed API key",
            ));
        }
        let url = format!("{site}{}", path_and_query(&request));
        let (parts, body) = request.into_parts();
        let has_body = method != Method::GET && method != Method::HEAD;
        let body = if has_body {
            match read_capped(body, &parts.headers).await {
                Some(body) => body,
                None => {
                    return no_store(error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Arguments are larger than 4 MB",
                    ));
                }
            }
        } else {
            Bytes::new()
        };
        let mut headers = HeaderMap::new();
        for (name, value) in client_ip_proof(&parts.headers, peer, self.secret.as_deref()) {
            set(&mut headers, name, &value);
        }
        for name in ["accept", "authorization", "content-type", "x-api-key"] {
            if let Some(value) = joined(&parts.headers, name).filter(|v| !v.is_empty()) {
                set(&mut headers, name, &value);
            }
        }
        let response = match self.send(method, &url, headers, body).await {
            Ok(response) => response,
            Err(why) => return self.unreachable(why),
        };
        let status = response.status();
        let mut out_headers = HeaderMap::new();
        out_headers.insert("cache-control", HeaderValue::from_static("no-store"));
        for name in ["content-type", "retry-after"] {
            if let Some(value) = response.headers().get(name) {
                out_headers.insert(HeaderName::from_static(name), value.clone());
            }
        }
        let body = match response.into_body().collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(e) => return self.unreachable(e.to_string()),
        };
        let mut out = Response::new(full(body));
        *out.status_mut() = status;
        *out.headers_mut() = out_headers;
        out
    }

    /// /api/mcp: the MCP server is a Convex HTTP action at the same path.
    pub async fn mcp(&self, request: Request<Incoming>, peer: IpAddr) -> Response<Body> {
        let Some(site) = &self.site else {
            return json_rpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The API is not available on this panel",
            );
        };
        let url = format!("{site}{}", path_and_query(&request));
        let (parts, body) = request.into_parts();
        let Some(body) = read_capped(body, &parts.headers).await else {
            return json_rpc_error(StatusCode::PAYLOAD_TOO_LARGE, "Request larger than 4 MB");
        };
        let mut headers = passable(&parts.headers);
        for (name, value) in client_ip_proof(&parts.headers, peer, self.secret.as_deref()) {
            set(&mut headers, name, &value);
        }
        match self.send(parts.method, &url, headers, body).await {
            Ok(response) => passthrough(response),
            Err(why) => {
                eprintln!("upstream request failed: {why}");
                json_rpc_error(
                    StatusCode::BAD_GATEWAY,
                    "The panel's backend did not answer",
                )
            }
        }
    }

    /// /api/connect/<token>, used by the server "connect" command: the
    /// install script and its registration callback are served by Convex;
    /// this keeps the command on the panel's own origin and tells Convex who
    /// is calling.
    pub async fn connect(
        &self,
        request: Request<Incoming>,
        peer: IpAddr,
        token: &str,
    ) -> Response<Body> {
        if !matches!(*request.method(), Method::GET | Method::HEAD | Method::POST) {
            return method_not_allowed("GET, HEAD, POST");
        }
        let (Some(site), true) = (&self.site, valid_token(token)) else {
            let mut response =
                Response::new(full("echo 'This command is not valid.' >&2; exit 1\n"));
            response.headers_mut().insert(
                "content-type",
                HeaderValue::from_static("text/plain; charset=utf-8"),
            );
            return response;
        };
        let headers = request.headers();
        let proto = first(joined(headers, "x-forwarded-proto")).unwrap_or_else(|| "http".into());
        let host = first(joined(headers, "x-forwarded-host"))
            .or_else(|| joined(headers, "host"))
            .unwrap_or_else(|| format!("localhost:{}", self.port));
        let client_ip = first(joined(headers, "cf-connecting-ip"))
            .or_else(|| first(Some(forwarded_for(headers, peer))))
            .or_else(|| first(joined(headers, "x-real-ip")));
        let mut upstream_headers = HeaderMap::new();
        set(
            &mut upstream_headers,
            "x-panara-cloud-connect-url",
            &format!("{proto}://{host}/api/connect/{token}"),
        );
        if let Some(ip) = client_ip {
            set(&mut upstream_headers, CLIENT_IP_HEADER, &ip);
        }
        let query = request
            .uri()
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default();
        let url = format!("{site}/infra/connect/{token}{query}");
        let method = request.method().clone();
        let response = match self
            .send(method, &url, upstream_headers, Bytes::new())
            .await
        {
            Ok(response) => response,
            Err(why) => return self.unreachable(why),
        };
        let status = response.status();
        let body = match response.into_body().collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(e) => return self.unreachable(e.to_string()),
        };
        let mut out = Response::new(full(body));
        *out.status_mut() = status;
        out.headers_mut().insert(
            "content-type",
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        no_store(out)
    }
}

fn valid_token(token: &str) -> bool {
    (20..=128).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn method_not_allowed(allow: &'static str) -> Response<Body> {
    let mut response = error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    response
        .headers_mut()
        .insert("allow", HeaderValue::from_static(allow));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_tokens_are_20_to_128_url_safe_characters() {
        assert!(valid_token("abcdefghijklmnopqrstuvwxyz"));
        assert!(valid_token("A1_-A1_-A1_-A1_-A1_-"));
        assert!(!valid_token("short"));
        assert!(!valid_token("abcdefghijklmnopqrst/uvwxyz"));
        assert!(!valid_token(&"a".repeat(129)));
    }
}
