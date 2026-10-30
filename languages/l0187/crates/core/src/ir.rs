// SPDX-License-Identifier: MIT

//! The semantic board: what a program declares, with no coordinates (design §8). Pages hold a
//! region tree — a page, section or group arranges its direct children by its `layout` — and the
//! page's connectors. Defaults are filled here, from the profile, so nothing downstream guesses.
//!
//! Built from the value tree the handlers checked ([`crate::eval`]), so its shape is known; a
//! surprise is reported as an internal error rather than unwrapped.

use graffiticode_l0000::{Record, Value};
use serde::Serialize;

use crate::eval::{CHILDREN, SETTINGS, key};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub show_page_tabs: bool,
    pub show_page_menu: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_key: Option<String>,
    pub pages: Vec<Page>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    pub region: Region,
    pub connectors: Vec<Connector>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Layout {
    Auto,
    Row,
    Column,
    Grid { columns: u32 },
    Flow { direction: Direction },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Direction {
    Right,
    Left,
    Down,
    Up,
}

/// A page, section or group's arrangement of its direct placeable children.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Region {
    pub layout: Layout,
    pub children: Vec<Child>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Child {
    Sticky(Mark),
    Shape(Mark),
    Textbox(Mark),
    Section(Section),
    Group(Group),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub id: String,
    pub text: String,
    /// A shape's outline; `None` on stickies and textboxes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_width: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub opacity: f64,
    pub font_size: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub before: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    pub opacity: f64,
    pub region: Region,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub before: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub region: Region,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub before: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<String>,
    pub stroke_width: String,
    pub opacity: f64,
    pub font_size: String,
    pub line_style: String,
    pub from_cap: String,
    pub to_cap: String,
}

impl Child {
    pub fn id(&self) -> &str {
        match self {
            Child::Sticky(m) | Child::Shape(m) | Child::Textbox(m) => &m.id,
            Child::Section(s) => &s.id,
            Child::Group(g) => &g.id,
        }
    }

    pub fn word(&self) -> &'static str {
        match self {
            Child::Sticky(_) => "sticky",
            Child::Shape(_) => "shape",
            Child::Textbox(_) => "textbox",
            Child::Section(_) => "section",
            Child::Group(_) => "group",
        }
    }

    pub fn before(&self) -> &[String] {
        match self {
            Child::Sticky(m) | Child::Shape(m) | Child::Textbox(m) => &m.before,
            Child::Section(s) => &s.before,
            Child::Group(g) => &g.before,
        }
    }

    pub fn region(&self) -> Option<&Region> {
        match self {
            Child::Section(s) => Some(&s.region),
            Child::Group(g) => Some(&g.region),
            _ => None,
        }
    }

    pub fn is_mark(&self) -> bool {
        matches!(self, Child::Sticky(_) | Child::Shape(_) | Child::Textbox(_))
    }
}

/* ------------------------------------------------------------------ building */

type Built<T> = Result<T, String>;

fn internal(what: &str) -> String {
    format!("internal error: the checked board has no {what}")
}

fn record<'a>(value: &'a Value, what: &str) -> Built<&'a Record> {
    match value {
        Value::Record(r) => Ok(r),
        _ => Err(internal(what)),
    }
}

/// The single `{word: inner}` entry of a typed item.
fn typed(value: &Value) -> Built<(String, &Value)> {
    let rec = record(value, "item")?;
    rec.iter().next().map(|(k, v)| (k.name().into_owned(), v)).ok_or_else(|| internal("item word"))
}

fn string(rec: &Record, word: &str) -> Option<String> {
    match rec.get(&key(word)) {
        Some(Value::Str(s)) => Some(s.clone()),
        Some(Value::Tag(t)) => Some(t.clone()),
        _ => None,
    }
}

fn required(rec: &Record, word: &str) -> Built<String> {
    string(rec, word).ok_or_else(|| internal(word))
}

fn number(rec: &Record, word: &str) -> Option<f64> {
    match rec.get(&key(word)) {
        Some(Value::Num(n)) => Some(n.to_f64()),
        _ => None,
    }
}

fn boolean(rec: &Record, word: &str) -> Option<bool> {
    match rec.get(&key(word)) {
        Some(Value::Bool(b)) => Some(*b),
        _ => None,
    }
}

fn ids(rec: &Record, word: &str) -> Vec<String> {
    match rec.get(&key(word)) {
        Some(Value::List(items)) => {
            items.iter().filter_map(|v| if let Value::Str(s) = v { Some(s.clone()) } else { None }).collect()
        }
        _ => Vec::new(),
    }
}

fn layout(settings: &Record) -> Layout {
    match string(settings, "layout").as_deref() {
        Some("ROW") => Layout::Row,
        Some("COLUMN") => Layout::Column,
        Some("GRID") => Layout::Grid { columns: number(settings, "columns").unwrap_or(1.0) as u32 },
        Some("FLOW") => Layout::Flow {
            direction: match string(settings, "direction").as_deref() {
                Some("LEFT") => Direction::Left,
                Some("DOWN") => Direction::Down,
                Some("UP") => Direction::Up,
                _ => Direction::Right,
            },
        },
        _ => Layout::Auto,
    }
}

fn parts(value: &Value) -> Built<(&Record, &[Value])> {
    let inner = record(value, "container")?;
    let settings = record(inner.get(&key(SETTINGS)).ok_or_else(|| internal(SETTINGS))?, SETTINGS)?;
    let children = match inner.get(&key(CHILDREN)) {
        Some(Value::List(items)) => items.as_slice(),
        _ => return Err(internal(CHILDREN)),
    };
    Ok((settings, children))
}

fn mark(word: &str, rec: &Record) -> Built<Mark> {
    Ok(Mark {
        id: required(rec, "id")?,
        text: required(rec, "text")?,
        kind: (word == "shape").then(|| string(rec, "kind").unwrap_or_else(|| "SQUARE".to_owned())),
        fill: string(rec, "fill"),
        stroke: string(rec, "stroke"),
        stroke_width: (word == "shape").then(|| string(rec, "stroke-width").unwrap_or_else(|| "THIN".to_owned())),
        color: string(rec, "color"),
        opacity: number(rec, "opacity").unwrap_or(100.0),
        font_size: string(rec, "font-size").unwrap_or_else(|| "MEDIUM".to_owned()),
        before: ids(rec, "before"),
    })
}

/// A region and the connectors written in it (only a page's list holds connectors).
fn region(settings: &Record, items: &[Value], connectors: &mut Vec<Connector>) -> Built<Region> {
    let mut children = Vec::new();
    for item in items {
        let (word, inner) = typed(item)?;
        let child = match word.as_str() {
            "sticky" | "shape" | "textbox" => {
                let m = mark(&word, record(inner, "mark")?)?;
                match word.as_str() {
                    "sticky" => Child::Sticky(m),
                    "shape" => Child::Shape(m),
                    _ => Child::Textbox(m),
                }
            }
            "section" => {
                let (s, items) = parts(inner)?;
                Child::Section(Section {
                    id: required(s, "id")?,
                    name: required(s, "name")?,
                    fill: string(s, "fill"),
                    opacity: number(s, "opacity").unwrap_or(100.0),
                    region: region(s, items, connectors)?,
                    before: ids(s, "before"),
                })
            }
            "group" => {
                let (s, items) = parts(inner)?;
                Child::Group(Group {
                    id: required(s, "id")?,
                    region: region(s, items, connectors)?,
                    before: ids(s, "before"),
                })
            }
            "connector" => {
                let c = record(inner, "connector")?;
                connectors.push(Connector {
                    id: required(c, "id")?,
                    from: required(c, "from")?,
                    to: required(c, "to")?,
                    label: string(c, "label"),
                    stroke: string(c, "stroke"),
                    stroke_width: string(c, "stroke-width").unwrap_or_else(|| "THIN".to_owned()),
                    opacity: number(c, "opacity").unwrap_or(100.0),
                    font_size: string(c, "font-size").unwrap_or_else(|| "SMALL".to_owned()),
                    line_style: string(c, "line-style").unwrap_or_else(|| "SOLID".to_owned()),
                    from_cap: string(c, "from-cap").unwrap_or_else(|| "NONE".to_owned()),
                    to_cap: string(c, "to-cap").unwrap_or_else(|| "ARROW_LINES".to_owned()),
                });
                continue;
            }
            other => return Err(internal(&format!("member {other}"))),
        };
        children.push(child);
    }
    Ok(Region { layout: layout(settings), children })
}

/// The semantic board from the board container's checked value.
pub fn build(board: &Value, file_key: Option<String>) -> Built<Board> {
    let (settings, items) = parts(board)?;
    let mut pages = Vec::with_capacity(items.len());
    for item in items {
        let (_, inner) = typed(item)?;
        let (s, items) = parts(inner)?;
        let mut connectors = Vec::new();
        let region = region(s, items, &mut connectors)?;
        pages.push(Page {
            id: required(s, "id")?,
            name: required(s, "name")?,
            background: string(s, "background"),
            region,
            connectors,
        });
    }
    Ok(Board {
        profile: string(settings, "layout-profile").unwrap_or_else(|| "FIGJAM_V1".to_owned()),
        title: string(settings, "title"),
        show_page_tabs: boolean(settings, "show-page-tabs").unwrap_or(pages.len() > 1),
        show_page_menu: boolean(settings, "show-page-menu").unwrap_or(false),
        file_key,
        pages,
    })
}

/// Every child in a region tree, depth first, with its parent region.
pub fn walk<'a>(region: &'a Region, visit: &mut impl FnMut(&'a Child, &'a Region)) {
    for child in &region.children {
        visit(child, region);
        if let Some(inner) = child.region() {
            walk(inner, visit);
        }
    }
}
