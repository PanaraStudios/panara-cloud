// The app's routes as the client router reads them (apps/web/lib/route-match.ts:
// `(group)` folders, `[param]`, `[...catchAll]`, `[[...optional]]`; a static
// segment beats a dynamic one, which beats a catch-all), with the build
// files each route module needs (routes.json, written by the build). A page
// route's index.html carries preload links for them, so the browser fetches
// the page's code together with the app's first script.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Group,
    Static,
    Dynamic,
    CatchAll,
    OptionalCatchAll,
}

#[derive(Debug)]
struct Node {
    segment: String,
    kind: Kind,
    /// Route modules in this folder; `page` is the page, if any.
    files: Vec<String>,
    page: Option<String>,
    children: Vec<Node>,
}

fn kind_of(segment: &str) -> Kind {
    if segment.starts_with('(') && segment.ends_with(')') {
        Kind::Group
    } else if segment.starts_with("[[...") && segment.ends_with("]]") {
        Kind::OptionalCatchAll
    } else if segment.starts_with("[...") && segment.ends_with(']') {
        Kind::CatchAll
    } else if segment.starts_with('[') && segment.ends_with(']') {
        Kind::Dynamic
    } else {
        Kind::Static
    }
}

fn rank(kind: Kind) -> i32 {
    match kind {
        Kind::Group => -1,
        Kind::Static => 3,
        Kind::Dynamic => 2,
        Kind::CatchAll => 1,
        Kind::OptionalCatchAll => 0,
    }
}

pub struct Routes {
    root: Node,
    preload: HashMap<String, Vec<String>>,
}

struct Table {
    files: Vec<String>,
    preload: HashMap<String, Vec<String>>,
}

fn strings(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|f| f.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn table(value: &serde_json::Value) -> Option<Table> {
    let files = strings(value.get("files")?);
    let preload = value
        .get("preload")?
        .as_object()?
        .iter()
        .map(|(file, list)| (file.clone(), strings(list)))
        .collect();
    Some(Table { files, preload })
}

struct Found<'a> {
    nodes: Vec<&'a Node>,
    score: Vec<i32>,
}

fn walk<'a>(
    node: &'a Node,
    segments: &[&str],
    at: usize,
    found: Found<'a>,
    out: &mut Vec<Found<'a>>,
) {
    if at == segments.len() && node.page.is_some() {
        out.push(Found {
            nodes: found.nodes.clone(),
            score: found.score.clone(),
        });
    }
    for child in &node.children {
        let consumed = match child.kind {
            Kind::Group => Some(0),
            Kind::Static => (segments.get(at) == Some(&child.segment.as_str())).then_some(1),
            Kind::Dynamic => (at < segments.len()).then_some(1),
            Kind::CatchAll => (at < segments.len()).then_some(segments.len() - at),
            Kind::OptionalCatchAll => Some(segments.len() - at),
        };
        let Some(consumed) = consumed else { continue };
        let mut nodes = found.nodes.clone();
        nodes.push(child);
        let mut score = found.score.clone();
        if child.kind != Kind::Group {
            score.push(rank(child.kind));
        }
        walk(child, segments, at + consumed, Found { nodes, score }, out);
    }
}

fn better(a: &[i32], b: &[i32]) -> bool {
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(-2);
        let y = b.get(i).copied().unwrap_or(-2);
        if x != y {
            return x > y;
        }
    }
    false
}

impl Routes {
    pub fn parse(json: &[u8]) -> Option<Routes> {
        let value: serde_json::Value = serde_json::from_slice(json).ok()?;
        let table = table(&value)?;
        let mut root = Node {
            segment: String::new(),
            kind: Kind::Static,
            files: vec![],
            page: None,
            children: vec![],
        };
        for path in &table.files {
            let Some(rest) = path.strip_prefix("/app/") else {
                continue;
            };
            let mut parts: Vec<&str> = rest.split('/').collect();
            let Some(file) = parts.pop() else { continue };
            let mut node = &mut root;
            for segment in parts {
                let index = match node.children.iter().position(|c| c.segment == segment) {
                    Some(index) => index,
                    None => {
                        node.children.push(Node {
                            segment: segment.to_string(),
                            kind: kind_of(segment),
                            files: vec![],
                            page: None,
                            children: vec![],
                        });
                        node.children.len() - 1
                    }
                };
                node = &mut node.children[index];
            }
            if file == "page.tsx" {
                node.page = Some(path.clone());
            } else {
                node.files.push(path.clone());
            }
        }
        Some(Routes {
            root,
            preload: table.preload,
        })
    }

    /// The page module a path renders, or None when no route matches.
    pub fn page_for(&self, pathname: &str) -> Option<String> {
        self.chain(pathname)
            .and_then(|nodes| nodes.last().and_then(|n| n.page.clone()))
    }

    fn chain(&self, pathname: &str) -> Option<Vec<&Node>> {
        let segments: Vec<&str> = pathname.split('/').filter(|s| !s.is_empty()).collect();
        let mut out = Vec::new();
        walk(
            &self.root,
            &segments,
            0,
            Found {
                nodes: vec![&self.root],
                score: vec![],
            },
            &mut out,
        );
        let mut best: Option<Found> = None;
        for candidate in out {
            if best
                .as_ref()
                .is_none_or(|b| better(&candidate.score, &b.score))
            {
                best = Some(candidate);
            }
        }
        best.map(|b| b.nodes)
    }

    /// The build files the route at this path loads lazily, in a stable order.
    pub fn preloads(&self, pathname: &str) -> Vec<String> {
        let Some(nodes) = self.chain(pathname) else {
            return vec![];
        };
        let every_page = "*".to_string();
        let mut modules: Vec<&String> = vec![&every_page];
        modules.extend(self.root.files.iter());
        for node in &nodes {
            modules.extend(node.files.iter());
        }
        if let Some(page) = nodes.last().and_then(|n| n.page.as_ref()) {
            modules.push(page);
        }
        let mut seen = std::collections::HashSet::new();
        let mut files = Vec::new();
        for module in modules {
            for file in self.preload.get(module).into_iter().flatten() {
                if seen.insert(file.clone()) {
                    files.push(file.clone());
                }
            }
        }
        files
    }
}

/// `<link>` tags that fetch the files ahead: scripts as module preloads,
/// stylesheets as stylesheets (the router would add them anyway).
pub fn link_tags(files: &[String]) -> String {
    files
        .iter()
        .filter(|f| !f.contains(['"', '<', '>']))
        .map(|f| {
            if f.ends_with(".css") {
                format!(r#"<link rel="stylesheet" crossorigin href="/{f}">"#)
            } else {
                format!(r#"<link rel="modulepreload" crossorigin href="/{f}">"#)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routes() -> Routes {
        Routes::parse(
            br#"{
            "files": [
                "/app/layout.tsx",
                "/app/not-found.tsx",
                "/app/(app)/layout.tsx",
                "/app/(app)/(auth)/login/page.tsx",
                "/app/(app)/(dashboard)/layout.tsx",
                "/app/(app)/(dashboard)/page.tsx",
                "/app/(app)/(dashboard)/[...pending]/page.tsx",
                "/app/(app)/(dashboard)/servers/page.tsx",
                "/app/(app)/(dashboard)/servers/new/page.tsx",
                "/app/(app)/(dashboard)/servers/[serverId]/layout.tsx",
                "/app/(app)/(dashboard)/servers/[serverId]/page.tsx",
                "/app/(app)/(dashboard)/docs/[[...slug]]/page.tsx"
            ],
            "preload": {
                "/app/(app)/(dashboard)/layout.tsx": ["assets/shell.js", "assets/shell.css"],
                "/app/(app)/(dashboard)/servers/page.tsx": ["assets/servers.js"],
                "/app/(app)/(dashboard)/servers/[serverId]/layout.tsx": ["assets/server.js", "assets/shared.js"],
                "/app/(app)/(dashboard)/servers/[serverId]/page.tsx": ["assets/overview.js", "assets/shared.js"],
                "/app/(app)/(auth)/login/page.tsx": ["assets/login.js"],
                "*": ["assets/vendor.js"]
            }
        }"#,
        )
        .unwrap()
    }

    #[test]
    fn matches_like_the_client_router() {
        let r = routes();
        assert_eq!(
            r.page_for("/").as_deref(),
            Some("/app/(app)/(dashboard)/page.tsx")
        );
        assert_eq!(
            r.page_for("/login").as_deref(),
            Some("/app/(app)/(auth)/login/page.tsx")
        );
        assert_eq!(
            r.page_for("/servers/new").as_deref(),
            Some("/app/(app)/(dashboard)/servers/new/page.tsx")
        );
        assert_eq!(
            r.page_for("/servers/abc").as_deref(),
            Some("/app/(app)/(dashboard)/servers/[serverId]/page.tsx")
        );
        assert_eq!(
            r.page_for("/servers/abc/x/y").as_deref(),
            Some("/app/(app)/(dashboard)/[...pending]/page.tsx")
        );
        assert_eq!(
            r.page_for("/docs").as_deref(),
            Some("/app/(app)/(dashboard)/docs/[[...slug]]/page.tsx")
        );
        assert_eq!(
            r.page_for("/docs/a/b").as_deref(),
            Some("/app/(app)/(dashboard)/docs/[[...slug]]/page.tsx")
        );
    }

    #[test]
    fn preloads_cover_the_layouts_and_the_page_once() {
        let r = routes();
        assert_eq!(
            r.preloads("/servers/abc"),
            [
                "assets/vendor.js",
                "assets/shell.js",
                "assets/shell.css",
                "assets/server.js",
                "assets/shared.js",
                "assets/overview.js"
            ]
        );
        // A parent route's page is not part of a child route.
        assert_eq!(
            r.preloads("/servers/new"),
            ["assets/vendor.js", "assets/shell.js", "assets/shell.css"]
        );
        assert_eq!(
            r.preloads("/login"),
            ["assets/vendor.js", "assets/login.js"]
        );
        assert!(
            link_tags(&r.preloads("/servers"))
                .contains(r#"<link rel="stylesheet" crossorigin href="/assets/shell.css">"#)
        );
    }
}
