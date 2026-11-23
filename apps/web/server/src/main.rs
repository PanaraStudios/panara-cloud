// Panara Cloud's web server: the built web app (apps/web/dist) as static
// files with index.html for every page route, and the panel's /api routes,
// proxied to the Convex site URL on the panel's own origin.
//
//   panara-cloud-web          serve on $PORT (3000)
//   panara-cloud-web health   exit 0 when the server on $PORT answers
//                             /api/health, for the container health check
//
// Environment: PORT, CONVEX_INTERNAL_SITE_URL, CONVEX_PUBLIC_URL,
// PANARA_CLOUD_LIVE_URL, PANARA_CLOUD_PROXY_SECRET (see docs/architecture.md)
// and PANARA_CLOUD_WEB_ROOT, the build to serve (default ./dist).

mod csp;
mod headers;
mod proxy;
mod routes;
mod statics;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::HeaderValue;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::convert::Infallible;
use std::net::IpAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub type Body = BoxBody<Bytes, hyper::Error>;

pub fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

pub fn json(status: StatusCode, value: &serde_json::Value) -> Response<Body> {
    let mut response = Response::new(full(value.to_string()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    response
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn port() -> u16 {
    env("PORT").and_then(|p| p.parse().ok()).unwrap_or(3000)
}

struct App {
    site: statics::Site,
    upstream: proxy::Upstream,
    csp: HeaderValue,
}

impl App {
    async fn handle(&self, request: Request<Incoming>, peer: IpAddr) -> Response<Body> {
        let path = request.uri().path().to_string();
        let page = !path.starts_with("/api/") && !path.starts_with("/assets/");
        let https = headers::first(headers::joined(request.headers(), "x-forwarded-proto"))
            .is_some_and(|proto| proto == "https");
        let mut response = self.route(request, &path, peer).await;
        let h = response.headers_mut();
        h.insert("x-frame-options", HeaderValue::from_static("DENY"));
        h.insert(
            "referrer-policy",
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        );
        h.insert(
            "x-content-type-options",
            HeaderValue::from_static("nosniff"),
        );
        if page {
            h.insert("content-security-policy", self.csp.clone());
            // Traefik terminates TLS and says so in X-Forwarded-Proto.
            if https {
                h.insert(
                    "strict-transport-security",
                    HeaderValue::from_static(csp::HSTS),
                );
            }
        }
        response
    }

    async fn route(&self, request: Request<Incoming>, path: &str, peer: IpAddr) -> Response<Body> {
        let method = request.method().clone();
        if path == "/api/health" {
            // Polled by the UI after panel reloads, updates and the port 3000
            // toggle, and by the container health check.
            let mut response = json(StatusCode::OK, &serde_json::json!({ "status": "ok" }));
            response
                .headers_mut()
                .insert("cache-control", HeaderValue::from_static("no-store"));
            return response;
        }
        if path == "/api/v1/openapi.json" {
            return match method {
                Method::GET | Method::HEAD => self.site.openapi(&method),
                _ => proxy::method_not_allowed("GET, HEAD"),
            };
        }
        if path.starts_with("/api/auth/") {
            return self.upstream.auth(request, peer).await;
        }
        if path.starts_with("/api/v1/") {
            return self.upstream.api(request, peer).await;
        }
        if path == "/api/mcp" {
            return self.upstream.mcp(request, peer).await;
        }
        if let Some(token) = path.strip_prefix("/api/connect/")
            && !token.is_empty()
            && !token.contains('/')
        {
            let token = token.to_string();
            return self.upstream.connect(request, peer, &token).await;
        }
        if path.starts_with("/api/") || path == "/api" {
            return json(
                StatusCode::NOT_FOUND,
                &serde_json::json!({ "error": "Not found" }),
            );
        }
        match method {
            Method::GET | Method::HEAD => self.site.serve(&method, path, request.headers()).await,
            _ => proxy::method_not_allowed("GET, HEAD"),
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

async fn serve() -> ExitCode {
    let port = port();
    let root = PathBuf::from(env("PANARA_CLOUD_WEB_ROOT").unwrap_or_else(|| "dist".into()));
    let convex_url = env("CONVEX_PUBLIC_URL");
    if convex_url.is_none() {
        eprintln!("CONVEX_PUBLIC_URL is not set: pages will not load (see docs/architecture.md)");
    }
    let live_url = env("PANARA_CLOUD_LIVE_URL");
    let config = serde_json::json!({ "convexUrl": convex_url });
    let site = match statics::Site::load(root.clone(), &config) {
        Ok(site) => site,
        Err(e) => {
            eprintln!("Cannot load the web app from {}: {e}", root.display());
            return ExitCode::FAILURE;
        }
    };
    let csp = csp::content_security_policy(convex_url.as_deref(), live_url.as_deref());
    let app = Arc::new(App {
        site,
        upstream: proxy::Upstream::new(
            env("CONVEX_INTERNAL_SITE_URL"),
            env("PANARA_CLOUD_PROXY_SECRET"),
            port,
        ),
        csp: HeaderValue::from_str(&csp).expect("the policy is ASCII"),
    });
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("Cannot listen on port {port}: {e}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!("Panara Cloud web listening on port {port}");
    let graceful = hyper_util::server::graceful::GracefulShutdown::new();
    let mut shutdown = std::pin::pin!(shutdown_signal());
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let _ = stream.set_nodelay(true);
                let app = app.clone();
                let service = service_fn(move |request| {
                    let app = app.clone();
                    async move { Ok::<_, Infallible>(app.handle(request, peer.ip()).await) }
                });
                let connection = hyper::server::conn::http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(Duration::from_secs(30))
                    .serve_connection(TokioIo::new(stream), service);
                let connection = graceful.watch(connection);
                tokio::spawn(async move {
                    let _ = connection.await;
                });
            }
            _ = &mut shutdown => break,
        }
    }
    drop(listener);
    // Requests in flight get a few seconds to finish; Swarm stops the old
    // task only after it exits.
    tokio::select! {
        _ = graceful.shutdown() => {}
        _ = tokio::time::sleep(Duration::from_secs(10)) => {}
    }
    ExitCode::SUCCESS
}

/// The health check: no shell, curl or second runtime in the image, so the
/// server checks itself. Fails on a refused connection, on any status but
/// 200, and when no status line arrives within 4 s.
async fn health() -> ExitCode {
    let port = port();
    let probe = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
        stream
            .write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await?;
        let mut status = [0u8; 12];
        stream.read_exact(&mut status).await?;
        Ok::<bool, std::io::Error>(&status[8..12] == b" 200")
    };
    match tokio::time::timeout(Duration::from_secs(4), probe).await {
        Ok(Ok(true)) => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}

fn main() -> ExitCode {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    match std::env::args().nth(1).as_deref() {
        Some("health") => runtime.block_on(health()),
        None => runtime.block_on(serve()),
        Some(other) => {
            eprintln!("Unknown command {other}; run without arguments to serve, or `health`");
            ExitCode::FAILURE
        }
    }
}
