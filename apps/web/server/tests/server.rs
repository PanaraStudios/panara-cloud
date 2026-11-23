// Runs the built server against a stand-in Convex site and a small build
// directory, over plain sockets.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Option<Seen> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':')?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Seen {
        method,
        target,
        headers,
        body,
    })
}

/// Answers every request with a JSON body naming its path, and keeps them.
fn upstream() -> (u16, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let Some(request) = read_request(&mut stream) else {
                continue;
            };
            let body = format!("{{\"path\":\"{}\"}}", request.target);
            let extra = if request.target.starts_with("/api/auth/") {
                "set-cookie: session=1; Path=/; HttpOnly\r\nlocation: /next\r\n"
            } else {
                "retry-after: 7\r\nx-upstream: yes\r\n"
            };
            let status = if request.target.starts_with("/api/auth/") {
                "302 Found"
            } else {
                "200 OK"
            };
            log.lock().unwrap().push(request);
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (port, seen)
}

fn build_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("panara-cloud-web-test-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::create_dir_all(dir.join("api/v1")).unwrap();
    std::fs::write(
        dir.join("index.html"),
        r#"<html><head><script type="application/json" id="panara-cloud-config">{}</script></head></html>"#,
    )
    .unwrap();
    std::fs::write(dir.join("assets/app-1.js"), "console.log(1)").unwrap();
    std::fs::write(dir.join("assets/app-1.js.br"), "BROTLI").unwrap();
    std::fs::write(dir.join("icon.svg"), "<svg/>").unwrap();
    std::fs::write(dir.join("api/v1/openapi.json"), r#"{"openapi":"3.1.0"}"#).unwrap();
    std::fs::write(
        dir.join("routes.json"),
        r#"{"files":["/app/layout.tsx","/app/projects/[projectId]/page.tsx","/app/[...pending]/page.tsx"],
            "preload":{"*":["assets/shared-1.js"],"/app/projects/[projectId]/page.tsx":["assets/project-1.js","assets/project-1.css"]}}"#,
    )
    .unwrap();
    dir
}

struct Server {
    child: Child,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn start(site_port: u16) -> Server {
    let port = free_port();
    let child = Command::new(env!("CARGO_BIN_EXE_panara-cloud-web"))
        .env("PORT", port.to_string())
        .env("PANARA_CLOUD_WEB_ROOT", build_dir())
        .env(
            "CONVEX_INTERNAL_SITE_URL",
            format!("http://127.0.0.1:{site_port}/"),
        )
        .env("CONVEX_PUBLIC_URL", "http://203.0.113.5:3210")
        .env("PANARA_CLOUD_LIVE_URL", "ws://203.0.113.5:7100")
        .env("PANARA_CLOUD_PROXY_SECRET", "s3cret")
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(Instant::now() < deadline, "the server did not start");
        std::thread::sleep(Duration::from_millis(20));
    }
    Server { child, port }
}

struct Reply {
    status: u16,
    headers: HashMap<String, Vec<String>>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(name)
            .and_then(|v| v.first())
            .map(String::as_str)
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

fn send(port: u16, request: &str, body: &[u8]) -> Reply {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    // A refused body may be cut short; the answer still arrives.
    let _ = stream.write_all(body);
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .unwrap_or_else(|| panic!("no response to {request}"));
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.lines();
    let status = lines
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let mut headers: HashMap<String, Vec<String>> = HashMap::new();
    for line in lines {
        let (name, value) = line.split_once(':').unwrap();
        headers
            .entry(name.trim().to_ascii_lowercase())
            .or_default()
            .push(value.trim().to_string());
    }
    Reply {
        status,
        headers,
        body: raw[split + 4..].to_vec(),
    }
}

fn get(port: u16, path: &str, headers: &str) -> Reply {
    send(
        port,
        &format!("GET {path} HTTP/1.1\r\nHost: panel.test\r\nConnection: close\r\n{headers}\r\n"),
        b"",
    )
}

fn post(port: u16, path: &str, headers: &str, body: &[u8]) -> Reply {
    send(
        port,
        &format!(
            "POST {path} HTTP/1.1\r\nHost: panel.test\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
            body.len()
        ),
        body,
    )
}

#[test]
fn serves_the_app_and_proxies_the_api() {
    let (site_port, seen) = upstream();
    let server = start(site_port);
    let port = server.port;

    let health = get(port, "/api/health", "");
    assert_eq!(health.status, 200);
    assert_eq!(health.text(), r#"{"status":"ok"}"#);
    assert_eq!(health.header("cache-control"), Some("no-store"));

    // Any page route is index.html with this install's config, the policy
    // and the security headers.
    let page = get(
        port,
        "/projects/p1/environment/e1?x=1",
        "X-Forwarded-Proto: https\r\n",
    );
    assert_eq!(page.status, 200);
    assert!(
        page.text()
            .contains(r#"{"convexUrl":"http://203.0.113.5:3210"}"#)
    );
    assert_eq!(page.header("cache-control"), Some("no-cache"));
    let csp = page.header("content-security-policy").unwrap();
    assert!(csp.contains("script-src 'self';"));
    assert!(csp.contains("connect-src 'self' http://203.0.113.5:3210 ws://203.0.113.5:3210 http://203.0.113.5:7100 ws://203.0.113.5:7100"));
    assert_eq!(
        page.header("strict-transport-security"),
        Some("max-age=31536000; includeSubDomains")
    );
    assert_eq!(page.header("x-frame-options"), Some("DENY"));
    assert_eq!(page.header("x-content-type-options"), Some("nosniff"));
    // The route's code is preloaded with the page, as Next.js's HTML did.
    let project = get(port, "/projects/p1", "").text();
    assert!(
        project.contains(r#"<link rel="modulepreload" crossorigin href="/assets/shared-1.js">"#)
    );
    assert!(
        project.contains(r#"<link rel="modulepreload" crossorigin href="/assets/project-1.js">"#)
    );
    assert!(
        project.contains(r#"<link rel="stylesheet" crossorigin href="/assets/project-1.css">"#)
    );
    let other = get(port, "/settings", "").text();
    assert!(other.contains("/assets/shared-1.js") && !other.contains("project-1"));
    // A volume or container name may contain dots; it is still a page.
    assert_eq!(get(port, "/servers/local/volumes/my.data", "").status, 200);
    let etag = page.header("etag").unwrap().to_string();
    assert_eq!(
        get(port, "/settings", &format!("If-None-Match: {etag}\r\n")).status,
        304
    );
    assert!(
        get(port, "/", "")
            .header("strict-transport-security")
            .is_none()
    );

    // Build files, precompressed when the browser takes it.
    let asset = get(port, "/assets/app-1.js", "Accept-Encoding: gzip, br\r\n");
    assert_eq!(asset.status, 200);
    assert_eq!(asset.text(), "BROTLI");
    assert_eq!(asset.header("content-encoding"), Some("br"));
    assert_eq!(
        asset.header("cache-control"),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(
        asset.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert!(asset.header("content-security-policy").is_none());
    let plain = get(port, "/assets/app-1.js", "");
    assert_eq!(plain.text(), "console.log(1)");
    assert_eq!(plain.header("content-encoding"), None);
    assert_eq!(get(port, "/assets/gone-2.js", "").status, 404);
    assert_eq!(
        get(port, "/icon.svg", "").header("content-type"),
        Some("image/svg+xml")
    );
    assert_eq!(
        get(port, "/assets/%2e%2e/%2e%2e/etc/passwd", "").status,
        404
    );
    assert_eq!(get(port, "/api/nothing", "").status, 404);

    let openapi = get(port, "/api/v1/openapi.json", "");
    assert_eq!(openapi.text(), r#"{"openapi":"3.1.0"}"#);
    assert_eq!(openapi.header("access-control-allow-origin"), Some("*"));
    assert_eq!(openapi.header("cache-control"), Some("public, max-age=300"));

    // /api/auth: everything but the hop-by-hop headers and the client's own
    // claims, plus the proof; the answer comes back as it is.
    let auth = post(
        port,
        "/api/auth/sign-in/email?x=1",
        "Content-Type: application/json\r\nCookie: a=b\r\nX-Forwarded-For: 9.9.9.9, 10.0.1.5\r\nX-Forwarded-Proto: https\r\nX-Forwarded-Host: panel.test\r\nx-panara-cloud-client-ip: 6.6.6.6\r\n",
        br#"{"email":"a"}"#,
    );
    assert_eq!(auth.status, 302);
    assert_eq!(
        auth.header("set-cookie"),
        Some("session=1; Path=/; HttpOnly")
    );
    assert_eq!(auth.header("location"), Some("/next"));
    let request = seen.lock().unwrap().last().unwrap().clone();
    assert_eq!(request.target, "/api/auth/sign-in/email?x=1");
    assert_eq!(request.body, br#"{"email":"a"}"#);
    assert_eq!(request.headers["cookie"], "a=b");
    assert_eq!(request.headers["x-panara-cloud-client-ip"], "10.0.1.5");
    assert_eq!(request.headers["x-panara-cloud-proxy-secret"], "s3cret");
    assert_eq!(
        request.headers["x-better-auth-forwarded-host"],
        format!("localhost:{port}")
    );
    assert_eq!(request.headers["x-better-auth-forwarded-proto"], "https");
    assert_eq!(request.headers["accept-encoding"], "application/json");
    assert!(!request.headers.contains_key("x-forwarded-host"));
    assert!(!request.headers.contains_key("x-forwarded-proto"));

    // /api/v1: a key first, then only the headers the gateway reads.
    let missing = get(port, "/api/v1/me", "");
    assert_eq!(missing.status, 401);
    assert_eq!(
        missing.text(),
        r#"{"error":"Missing or malformed API key"}"#
    );
    let call = post(
        port,
        "/api/v1/call/projects.list",
        "x-api-key: k\r\nContent-Type: application/json\r\nCookie: z=1\r\n",
        b"{}",
    );
    assert_eq!(call.status, 200);
    assert_eq!(call.header("retry-after"), Some("7"));
    assert_eq!(call.header("cache-control"), Some("no-store"));
    assert_eq!(call.header("x-upstream"), None);
    let request = seen.lock().unwrap().last().unwrap().clone();
    assert_eq!(request.target, "/api/v1/call/projects.list");
    assert_eq!(request.headers["x-api-key"], "k");
    assert_eq!(request.headers["x-panara-cloud-client-ip"], "127.0.0.1");
    assert!(!request.headers.contains_key("cookie"));
    let large = post(
        port,
        "/api/v1/call/x",
        "x-api-key: k\r\n",
        &vec![b'x'; 4 * 1024 * 1024 + 1],
    );
    assert_eq!(large.status, 413);
    assert_eq!(
        large.text(),
        r#"{"error":"Arguments are larger than 4 MB"}"#
    );

    // /api/mcp goes to the same path on Convex.
    let mcp = post(
        port,
        "/api/mcp?groups=projects",
        "x-api-key: k\r\nAccept: application/json, text/event-stream\r\n",
        b"{}",
    );
    assert_eq!(mcp.status, 200);
    assert_eq!(mcp.header("x-upstream"), Some("yes"));
    let request = seen.lock().unwrap().last().unwrap().clone();
    assert_eq!(request.target, "/api/mcp?groups=projects");
    assert_eq!(
        request.headers["accept"],
        "application/json, text/event-stream"
    );

    // /api/connect/<token>: the command's own URL and the caller.
    let connect = get(
        port,
        "/api/connect/abcdefghijklmnopqrstuvwxyz?x=2",
        "X-Forwarded-For: 5.5.5.5, 10.0.0.2\r\n",
    );
    assert_eq!(connect.status, 200);
    assert_eq!(
        connect.header("content-type"),
        Some("text/plain; charset=utf-8")
    );
    let request = seen.lock().unwrap().last().unwrap().clone();
    assert_eq!(request.method, "GET");
    assert_eq!(
        request.target,
        "/infra/connect/abcdefghijklmnopqrstuvwxyz?x=2"
    );
    assert_eq!(
        request.headers["x-panara-cloud-connect-url"],
        "http://panel.test/api/connect/abcdefghijklmnopqrstuvwxyz"
    );
    assert_eq!(request.headers["x-panara-cloud-client-ip"], "5.5.5.5");
    let bad = get(port, "/api/connect/short", "");
    assert_eq!(
        bad.text(),
        "echo 'This command is not valid.' >&2; exit 1\n"
    );

    // The container health check.
    let status = Command::new(env!("CARGO_BIN_EXE_panara-cloud-web"))
        .arg("health")
        .env("PORT", port.to_string())
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn the_health_check_fails_when_nothing_answers() {
    let status = Command::new(env!("CARGO_BIN_EXE_panara-cloud-web"))
        .arg("health")
        .env("PORT", free_port().to_string())
        .status()
        .unwrap();
    assert!(!status.success());
}
