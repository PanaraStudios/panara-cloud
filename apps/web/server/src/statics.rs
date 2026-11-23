use crate::routes::{Routes, link_tags};
use crate::{Body, full};
use bytes::Bytes;
use hyper::header::HeaderValue;
use hyper::{HeaderMap, Method, Response, StatusCode};
use std::collections::HashMap;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// The JSON block index.html carries for the runtime config; the server
/// fills it in, so the page needs no inline script.
const CONFIG_PLACEHOLDER: &str =
    r#"<script type="application/json" id="panara-cloud-config">{}</script>"#;
pub const OPENAPI_FILE: &str = "api/v1/openapi.json";
/// Route modules and the build files each needs; written by the build.
const ROUTES_FILE: &str = "routes.json";

/// The built web app: index.html for every page route, with this install's
/// config, and the files beside it.
pub struct Site {
    root: PathBuf,
    index: String,
    routes: Option<Routes>,
    /// index.html per page module, with that route's preload links.
    pages: Mutex<HashMap<String, (Bytes, String)>>,
    openapi: Bytes,
}

pub fn config_script(config: &serde_json::Value) -> String {
    // `<` escaped so no value can close the script element.
    let json = config.to_string().replace('<', "\\u003c");
    CONFIG_PLACEHOLDER.replace("{}", &json)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// A request path as a path under the root, or None when it tries to leave
/// it or is not valid UTF-8 after percent-decoding.
fn relative_path(url_path: &str) -> Option<PathBuf> {
    let bytes = url_path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    let text = String::from_utf8(decoded).ok()?;
    if text.contains('\0') || text.contains('\\') {
        return None;
    }
    let relative = PathBuf::from(text.trim_start_matches('/'));
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    Some(relative)
}

fn accepts(headers: &HeaderMap, encoding: &str) -> bool {
    headers
        .get_all("accept-encoding")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|part| {
            let mut pieces = part.trim().split(';');
            let name = pieces.next().unwrap_or("").trim();
            let refused = pieces.any(|p| {
                let p = p.trim().replace(' ', "");
                p == "q=0" || p == "q=0.0" || p == "q=0.00" || p == "q=0.000"
            });
            name.eq_ignore_ascii_case(encoding) && !refused
        })
}

fn not_modified(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all("if-none-match")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|tag| {
            let tag = tag.trim();
            tag == "*" || tag == etag || tag.strip_prefix("W/") == Some(etag)
        })
}

fn response(status: StatusCode, body: Bytes, head: bool) -> Response<Body> {
    let mut response = Response::new(if head { full(Bytes::new()) } else { full(body) });
    *response.status_mut() = status;
    response
}

fn not_found() -> Response<Body> {
    let mut response = Response::new(full("Not found\n"));
    *response.status_mut() = StatusCode::NOT_FOUND;
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

impl Site {
    pub fn load(root: PathBuf, config: &serde_json::Value) -> io::Result<Site> {
        let html = std::fs::read_to_string(root.join("index.html"))?;
        if !html.contains(CONFIG_PLACEHOLDER) {
            return Err(io::Error::other(
                "index.html has no runtime config placeholder",
            ));
        }
        let index = html.replace(CONFIG_PLACEHOLDER, &config_script(config));
        let openapi = std::fs::read(root.join(OPENAPI_FILE)).unwrap_or_default();
        let routes = std::fs::read(root.join(ROUTES_FILE))
            .ok()
            .and_then(|json| Routes::parse(&json));
        if routes.is_none() {
            eprintln!("{ROUTES_FILE} is missing or unreadable: pages load without preloads");
        }
        Ok(Site {
            root,
            index,
            routes,
            pages: Mutex::new(HashMap::new()),
            openapi: Bytes::from(openapi),
        })
    }

    fn page_html(&self, path: &str) -> (Bytes, String) {
        let key = self
            .routes
            .as_ref()
            .and_then(|routes| routes.page_for(path))
            .unwrap_or_default();
        if let Some(found) = self.pages.lock().unwrap().get(&key) {
            return found.clone();
        }
        let links = self
            .routes
            .as_ref()
            .map(|routes| link_tags(&routes.preloads(path)))
            .unwrap_or_default();
        let html = self
            .index
            .replacen("</head>", &format!("{links}</head>"), 1);
        let etag = format!("\"{:x}\"", fnv1a(html.as_bytes()));
        let page = (Bytes::from(html), etag);
        self.pages.lock().unwrap().insert(key, page.clone());
        page
    }

    /// Any page route: the app's index.html, never cached without asking,
    /// so an update reaches the next page load.
    pub fn index(&self, method: &Method, path: &str, headers: &HeaderMap) -> Response<Body> {
        let (html, etag) = self.page_html(path);
        let mut out = if not_modified(headers, &etag) {
            response(StatusCode::NOT_MODIFIED, Bytes::new(), true)
        } else {
            response(StatusCode::OK, html, method == Method::HEAD)
        };
        let h = out.headers_mut();
        h.insert(
            "content-type",
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        h.insert("cache-control", HeaderValue::from_static("no-cache"));
        if let Ok(etag) = HeaderValue::from_str(&etag) {
            h.insert("etag", etag);
        }
        out
    }

    /// The OpenAPI document: it holds no secrets, so it needs no key and may
    /// be fetched by tools on other origins.
    pub fn openapi(&self, method: &Method) -> Response<Body> {
        if self.openapi.is_empty() {
            return not_found();
        }
        let mut out = response(StatusCode::OK, self.openapi.clone(), method == Method::HEAD);
        let h = out.headers_mut();
        h.insert("content-type", HeaderValue::from_static("application/json"));
        h.insert(
            "cache-control",
            HeaderValue::from_static("public, max-age=300"),
        );
        h.insert("access-control-allow-origin", HeaderValue::from_static("*"));
        out
    }

    /// A file of the build, a 404 for a missing build asset, and index.html
    /// for anything else (a page route, whose path may contain dots).
    pub async fn serve(&self, method: &Method, path: &str, headers: &HeaderMap) -> Response<Body> {
        let Some(relative) = relative_path(path) else {
            return not_found();
        };
        let is_asset = relative.starts_with("assets");
        let file = self.root.join(&relative);
        let meta = match tokio::fs::metadata(&file).await {
            Ok(meta) if meta.is_file() && relative != Path::new("index.html") => meta,
            _ if is_asset => return not_found(),
            _ => return self.index(method, path, headers),
        };
        let mut chosen = file.clone();
        let mut encoding = None;
        for (name, suffix) in [("br", "br"), ("gzip", "gz")] {
            if !accepts(headers, name) {
                continue;
            }
            let candidate = PathBuf::from(format!("{}.{suffix}", file.display()));
            if tokio::fs::metadata(&candidate)
                .await
                .is_ok_and(|m| m.is_file())
            {
                chosen = candidate;
                encoding = Some(name);
                break;
            }
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let etag = format!(
            "\"{:x}-{:x}{}\"",
            meta.len(),
            modified,
            encoding.map(|e| format!("-{e}")).unwrap_or_default()
        );
        let mut out = if not_modified(headers, &etag) {
            response(StatusCode::NOT_MODIFIED, Bytes::new(), true)
        } else {
            match tokio::fs::read(&chosen).await {
                Ok(bytes) => response(StatusCode::OK, Bytes::from(bytes), method == Method::HEAD),
                Err(_) => return not_found(),
            }
        };
        let h = out.headers_mut();
        h.insert(
            "content-type",
            HeaderValue::from_static(content_type(&file)),
        );
        h.insert(
            "cache-control",
            HeaderValue::from_static(if is_asset {
                // Vite puts a content hash in every asset name.
                "public, max-age=31536000, immutable"
            } else {
                "public, max-age=0"
            }),
        );
        if let Ok(etag) = HeaderValue::from_str(&etag) {
            h.insert("etag", etag);
        }
        h.insert("vary", HeaderValue::from_static("Accept-Encoding"));
        if let Some(encoding) = encoding {
            h.insert("content-encoding", HeaderValue::from_static(encoding));
        }
        out
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, b| {
        (hash ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_under_the_root() {
        assert_eq!(
            relative_path("/assets/a-1.js"),
            Some(PathBuf::from("assets/a-1.js"))
        );
        assert_eq!(
            relative_path("/icon%2Esvg"),
            Some(PathBuf::from("icon.svg"))
        );
        assert_eq!(relative_path("/../etc/passwd"), None);
        assert_eq!(relative_path("/assets/%2e%2e/%2e%2e/x"), None);
        assert_eq!(relative_path("/a%5c..%5cb"), None);
        assert_eq!(relative_path("/a%00"), None);
        assert_eq!(relative_path("/bad%zz"), None);
        assert_eq!(relative_path("/"), Some(PathBuf::from("")));
    }

    #[test]
    fn encodings_follow_accept_encoding() {
        let mut h = HeaderMap::new();
        h.insert(
            "accept-encoding",
            HeaderValue::from_static("gzip, deflate, br;q=0"),
        );
        assert!(accepts(&h, "gzip"));
        assert!(!accepts(&h, "br"));
        h.insert("accept-encoding", HeaderValue::from_static("br, gzip"));
        assert!(accepts(&h, "br"));
    }

    #[test]
    fn the_config_cannot_close_its_script_element() {
        let script = config_script(&serde_json::json!({ "convexUrl": "</script><script>x" }));
        assert!(!script.contains("</script><script>"));
        assert!(
            script.starts_with(r#"<script type="application/json" id="panara-cloud-config">{"#)
        );
    }
}
