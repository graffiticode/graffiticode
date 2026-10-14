// SPDX-License-Identifier: MIT

//! Board assembly, over plain objects: typed members become the nodes the FigJam plugin draws,
//! pages get their names, and every connector endpoint is resolved against its page.
//!
//! The output contract is the plugin's (`figma-plugin/src/code.ts`): `{type: "board", pages:
//! [{name, nodes}]}`, where each node carries exactly the fields the plugin reads. Only fields
//! the program wrote are emitted. A failure is the message the TypeScript throws, a JavaScript
//! `TypeError` included where a record written as a literal has the wrong shape.

use indexmap::{IndexMap, IndexSet};

use crate::plain::{Plain, entries, js_string, object, stringify, truthy};
use crate::vocab::{VOCAB, example_of};

type Fallible<T> = Result<T, String>;

/* ------------------------------------------------------------------ save-to-figjam */

/// `/figma\.com\/(?:board|design|file)\/([A-Za-z0-9]+)/`, the first match's key.
fn figma_url_key(text: &str) -> Option<&str> {
    text.match_indices("figma.com/").find_map(|(at, prefix)| {
        let rest = &text[at + prefix.len()..];
        let rest = ["board/", "design/", "file/"].iter().find_map(|kind| rest.strip_prefix(kind))?;
        let end = rest.find(|c: char| !c.is_ascii_alphanumeric()).unwrap_or(rest.len());
        (end > 0).then(|| &rest[..end])
    })
}

/// A FigJam file key from a bare key or a figma.com board/design/file link.
pub fn parse_file_key(input: &Plain) -> Fallible<String> {
    if let Plain::Str(text) = input {
        let text = crate::plain::trim(text);
        if let Some(key) = figma_url_key(text) {
            return Ok(key.to_owned());
        }
        if text.len() >= 6 && text.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Ok(text.to_owned());
        }
    }
    let got = match input {
        Plain::Str(_) => stringify(input),
        _ => "something else".to_owned(),
    };
    Err(format!(
        "save-to-figjam: expected a FigJam link like \"https://www.figma.com/board/ABC123/Name\" or a bare file key like \"ABC123\", got {got}."
    ))
}

/* ------------------------------------------------------------------ nodes */

/// `{ type, ...rec }` with `rec`'s `omit` field left out (a destructured `{ kind, ...rest }`).
fn node(kind: &str, extra: Option<(&str, Plain)>, rec: &Plain, omit: Option<&str>) -> Plain {
    let mut fields = vec![("type".to_owned(), Plain::Str(kind.to_owned()))];
    fields.extend(extra.map(|(key, value)| (key.to_owned(), value)));
    fields.extend(entries(rec).into_iter().filter(|(key, _)| Some(key.as_str()) != omit));
    let mut out = IndexMap::new();
    for (key, value) in fields {
        out.insert(key, value);
    }
    object(out)
}

/// A typed member's record, as the node the plugin draws. `type` comes first, like L0172's.
pub fn to_node(member: &str, rec: &Plain, at: &str) -> Fallible<Plain> {
    let one_of = |kinds: &[String]| kinds.join(", ");
    match member {
        "sticky" => Ok(node("sticky", None, rec, None)),
        "textbox" => Ok(node("text", None, rec, None)),
        "shape" => {
            let kind = rec.get("kind")?;
            if !kind.is_undefined() && !kind.as_str().is_some_and(|k| VOCAB.shape_kinds.iter().any(|s| s == k)) {
                return Err(format!(
                    "{at}: kind {} is a stamp, not a shape. A shape's kind is one of {}.",
                    js_string(kind),
                    one_of(&VOCAB.shape_kinds)
                ));
            }
            let shape_type = if kind.is_nullish() { Plain::Str("SQUARE".to_owned()) } else { kind.clone() };
            Ok(node("shape", Some(("shapeType", shape_type)), rec, Some("kind")))
        }
        "stamp" => {
            let kind = rec.get("kind")?;
            if kind.is_undefined() {
                return Err(format!(
                    "{at}: needs a kind, one of {}, e.g. {}.",
                    one_of(&VOCAB.stamp_kinds),
                    example_of("stamp")
                ));
            }
            let Some(kind) = kind.as_str().filter(|k| VOCAB.stamp_kinds.iter().any(|s| s == k)) else {
                return Err(format!(
                    "{at}: kind {} is a shape, not a stamp. A stamp's kind is one of {}.",
                    js_string(kind),
                    one_of(&VOCAB.stamp_kinds)
                ));
            };
            Ok(node("stamp", Some(("stamp", Plain::Str(kind.to_lowercase()))), rec, Some("kind")))
        }
        "connector" => {
            for end in ["from", "to"] {
                if rec.get(end)?.is_undefined() {
                    return Err(format!("{at}: needs both from and to, e.g. {}.", example_of("connector")));
                }
            }
            // FigJam refuses a CENTER magnet on elbowed and curved connectors.
            for (field, word) in [("fromSide", "from-side"), ("toSide", "to-side")] {
                let line_type = rec.get("lineType")?;
                if rec.get(field)?.as_str() == Some("center") && line_type.as_str() != Some("straight") {
                    let kind = match line_type {
                        Plain::Undefined | Plain::Null => "ELBOWED".to_owned(),
                        Plain::Str(text) => text.to_uppercase(),
                        _ => return Err("(rec.lineType ?? \"elbowed\").toUpperCase is not a function".to_owned()),
                    };
                    let article = if kind == "ELBOWED" { "an" } else { "a" };
                    return Err(format!(
                        "{at}: {word} CENTER needs line-type STRAIGHT; FigJam cannot attach {article} {kind} connector at a node's centre. Use AUTO, TOP, BOTTOM, LEFT or RIGHT, or add line-type STRAIGHT."
                    ));
                }
            }
            let fans = |end: &Plain| matches!(end, Plain::List(_)) || end.as_str() == Some("*");
            if !rec.get("waypoints")?.is_undefined() && (fans(rec.get("from")?) || fans(rec.get("to")?)) {
                return Err(format!(
                    "{at}: waypoints route one line: give a single from and a single to, e.g. connector from \"a\" to \"b\" waypoints [ waypoint [300 0] ] {{}}."
                ));
            }
            Ok(node("connector", None, rec, None))
        }
        _ => Err(format!("{at}: unknown member {member}.")),
    }
}

/// A node's description in errors: `sticky "kick"`, or `sticky 3` when it has no key.
pub fn node_name(member: &str, rec: &Plain, i: usize) -> Fallible<String> {
    let id = rec.get("id")?;
    let key = if !id.is_nullish() {
        id
    } else if member == "section" {
        rec.get("name")?
    } else {
        rec.get("text")?
    };
    Ok(match key {
        Plain::Undefined => format!("{member} {}", i + 1),
        Plain::Str(text) if text.is_empty() => format!("{member} {}", i + 1),
        _ => format!("{member} {}", stringify(key)),
    })
}

/// The key the plugin registers a drawn node under, mirroring its `primaryKey`: shapes,
/// stickies and text by id, falling back to text; sections by name; stamps by their reaction.
pub fn primary_key(n: &Plain) -> Fallible<Option<String>> {
    let name_of = |value: &Plain| (!value.is_nullish()).then(|| js_string(value));
    Ok(match n.get("type")?.as_str() {
        Some("shape" | "sticky" | "text") => match name_of(n.get("id")?) {
            Some(id) => Some(id),
            None => name_of(n.get("text")?),
        },
        Some("section") => name_of(n.get("name")?),
        Some("stamp") => Some(js_string(n.get("stamp")?)),
        _ => None,
    })
}

/// Every node on a page, in drawing order, sections' contents in place (as the plugin walks
/// them).
pub fn walk(nodes: &Plain, visit: &mut dyn FnMut(&Plain) -> Fallible<()>) -> Fallible<()> {
    let items: Vec<Plain> = match nodes {
        Plain::List(items) => items.clone(),
        // A string iterates by code point.
        Plain::Str(text) => text.chars().map(|c| Plain::Str(c.to_string())).collect(),
        _ => return Err("nodes is not iterable".to_owned()),
    };
    for n in &items {
        if n.get("type")?.as_str() == Some("section") {
            visit(n)?;
            walk(n.get("nodes")?, visit)?;
        } else {
            visit(n)?;
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------ pages */

struct Page {
    name: Plain,
    background: Plain,
    nodes: Plain,
}

fn quote_list(keys: &[&String]) -> String {
    let shown: Vec<String> = keys.iter().take(12).map(|key| crate::plain::quote(key)).collect();
    let more = if keys.len() > 12 { format!(", … ({} in all)", keys.len()) } else { String::new() };
    shown.join(", ") + &more
}

/// Checks a page's keys and connectors. Ids are unique on a page; every endpoint names a node
/// the plugin will register on the same page, or is "*". The checks run over the whole board
/// so an endpoint that names a node on another page says which.
fn check_page(page: &Page, page_where: &str, others: &[&Page]) -> Fallible<()> {
    let mut ids: IndexSet<String> = IndexSet::new();
    let mut keys: IndexMap<String, usize> = IndexMap::new();
    let mut section_names: IndexSet<String> = IndexSet::new();
    walk(&page.nodes, &mut |n| {
        let id = n.get("id")?;
        if !id.is_nullish() {
            let id = js_string(id);
            if ids.contains(&id) {
                return Err(format!(
                    "{page_where}: two nodes have the id {}. Ids must be unique on a page.",
                    crate::plain::quote(&id)
                ));
            }
            ids.insert(id);
        }
        if n.get("type")?.as_str() == Some("section") {
            let name = n.get("name")?;
            if !name.is_nullish() {
                section_names.insert(js_string(name));
            }
        }
        if let Some(key) = primary_key(n)? {
            *keys.entry(key).or_default() += 1;
        }
        Ok(())
    })?;
    let known: Vec<&String> = keys.keys().collect();
    walk(&page.nodes, &mut |n| {
        if n.get("type")?.as_str() != Some("connector") {
            return Ok(());
        }
        for end in ["from", "to"] {
            let names = match n.get(end)? {
                Plain::List(items) => items.clone(),
                one => vec![one.clone()],
            };
            for name in &names {
                if name.as_str() == Some("*") {
                    continue;
                }
                let text = name.as_str();
                let count = text.and_then(|text| keys.get(text)).copied().unwrap_or(0);
                let at = format!("{page_where}: connector {end} {}", stringify(name));
                // The plugin registers a section after its contents and the first registration
                // of a key wins, so a section sharing its name with a node is reached only
                // sometimes. Ask for a different name rather than guess.
                if count > 1 && text.is_some_and(|text| section_names.contains(text)) {
                    return Err(format!(
                        "{at}: {count} nodes are called {}, one of them a section, so it could mean any of them. Give the section a name no other node uses.",
                        stringify(name)
                    ));
                }
                if count > 1 && !text.is_some_and(|text| ids.contains(text)) {
                    let shown = stringify(name);
                    return Err(format!(
                        "{at}: {count} nodes say {shown}, so it could mean any of them. Give the one you mean an id, e.g. sticky id \"a\" text {shown} {{}}, and connect to \"a\"."
                    ));
                }
                if count > 0 {
                    continue;
                }
                let mut elsewhere = None;
                for other in others {
                    let mut found = false;
                    // `primaryKey(m) === name`: a key is a string or null.
                    walk(&other.nodes, &mut |m| {
                        if !found {
                            found = match name {
                                Plain::Str(_) | Plain::Null => primary_key(m)?.as_deref() == text,
                                _ => false,
                            };
                        }
                        Ok(())
                    })?;
                    if found {
                        elsewhere = Some(other);
                        break;
                    }
                }
                if let Some(other) = elsewhere {
                    return Err(format!(
                        "{at}: that node is on page {}. A connector joins nodes on its own page.",
                        stringify(&other.name)
                    ));
                }
                let has = if known.is_empty() {
                    " The page has no nodes to connect.".to_owned()
                } else {
                    format!(" It has: {}.", quote_list(&known))
                };
                return Err(format!("{at}: no node on this page has that id or text.{has}"));
            }
        }
        Ok(())
    })
}

/* ------------------------------------------------------------------ board */

/// `Set` membership: by value, except objects and lists, which are only ever themselves.
fn same_value(a: &Plain, b: &Plain) -> bool {
    match (a, b) {
        (Plain::Num(a), Plain::Num(b)) => a == b || (a.is_nan() && b.is_nan()),
        (Plain::List(_) | Plain::Object(_) | Plain::Decimal(_), _) => false,
        _ => a == b,
    }
}

/// Names the pages, applies the tab defaults, and checks every page's connectors.
pub fn build_board(pages: &[Plain], settings: &Plain) -> Fallible<Plain> {
    if pages.is_empty() {
        return Err(format!("board: needs at least one page, e.g. {}.", example_of("board")));
    }
    let mut named = Vec::with_capacity(pages.len());
    for (i, rec) in pages.iter().enumerate() {
        let nodes = rec.get("nodes")?.clone();
        let s = rec.get("settings")?;
        let name = s.get("name")?;
        if name.is_undefined() && pages.len() > 1 {
            return Err(format!(
                "board: page {} needs a name — a board with more than one page names every page, e.g. page [ … ] name \"Retro\" {{}}.",
                i + 1
            ));
        }
        let name = if name.is_nullish() { Plain::Str("Page 1".to_owned()) } else { name.clone() };
        named.push(Page { name, background: s.get("background")?.clone(), nodes });
    }
    for (i, page) in named.iter().enumerate() {
        if named[..i].iter().any(|seen| same_value(&seen.name, &page.name)) {
            return Err(format!("board: two pages are named {}. Page names must be unique.", stringify(&page.name)));
        }
    }
    for (i, page) in named.iter().enumerate() {
        let others: Vec<&Page> = named.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, p)| p).collect();
        check_page(page, &format!("page {}", stringify(&page.name)), &others)?;
    }
    let tabs = settings.get("showPageTabs")?;
    let tabs = if tabs.is_nullish() { Plain::Bool(named.len() > 1) } else { tabs.clone() };
    let menu = settings.get("showPageMenu")?;
    let menu = if menu.is_nullish() { Plain::Bool(false) } else { menu.clone() };
    if named.len() > 1 && !truthy(&tabs) && !truthy(&menu) {
        return Err(
            "board: show-page-tabs false hides every page but the first. Keep the tabs, or add show-page-menu true."
                .to_owned(),
        );
    }
    let pages: Vec<Plain> = named
        .into_iter()
        .map(|page| {
            let mut fields = vec![("name", page.name), ("nodes", page.nodes)];
            if !page.background.is_undefined() {
                fields.push(("background", page.background));
            }
            object(fields)
        })
        .collect();
    let mut board = vec![
        ("type", Plain::Str("board".to_owned())),
        ("showPageTabs", tabs),
        ("showPageMenu", menu),
        ("pages", Plain::List(pages)),
    ];
    let title = settings.get("title")?;
    if !title.is_undefined() {
        board.push(("title", title.clone()));
    }
    Ok(object(board))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_keys_come_from_links_or_bare_keys() {
        let key = |s: &str| parse_file_key(&Plain::Str(s.to_owned()));
        assert_eq!(key("https://www.figma.com/board/ABC123/Demo?node-id=0-1").unwrap(), "ABC123");
        assert_eq!(key("x figma.com/proto/1 figma.com/file/Q1w2/x").unwrap(), "Q1w2");
        assert_eq!(key("  XYZ987 ").unwrap(), "XYZ987");
        assert!(key("ABC12").is_err());
        assert!(key("https://www.figma.com/board/").is_err());
        assert!(parse_file_key(&Plain::Num(123456.0)).unwrap_err().ends_with("got something else."));
    }

    #[test]
    fn primary_keys_mirror_the_plugin() {
        let sticky = object([("type", Plain::Str("sticky".into())), ("text", Plain::Num(5.0))]);
        assert_eq!(primary_key(&sticky).unwrap().as_deref(), Some("5"));
        let stamp = object([("type", Plain::Str("stamp".into())), ("stamp", Plain::Str("like".into()))]);
        assert_eq!(primary_key(&stamp).unwrap().as_deref(), Some("like"));
        let connector = object([("type", Plain::Str("connector".into()))]);
        assert_eq!(primary_key(&connector).unwrap(), None);
    }
}
