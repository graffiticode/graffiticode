// SPDX-License-Identifier: MIT

//! Resolution of the semantic board (design §4, §5): one board-wide id namespace, one tier of
//! visible sections, connector endpoints on the same page, and `before` orders that are legal
//! and acyclic. Each error names the ids involved and a repair written in L0187.

use std::collections::{BTreeMap, HashMap};

use graffiticode_l0000::{Diagnostic, Span};

use crate::diag::source;
use crate::ir::{Board, Child, Layout, Region};

/// Where each id literal was written: the spans of `id "…"` properties, in source order.
pub type SourceMap = HashMap<String, Vec<Span>>;

/// What an id names, for messages and endpoint checks.
#[derive(Clone, Debug)]
struct Entry {
    word: &'static str,
    page: usize,
    is_mark: bool,
}

struct Resolver<'a> {
    board: &'a Board,
    spans: &'a SourceMap,
    errors: Vec<Diagnostic>,
}

impl Resolver<'_> {
    /// The span of the `n`th place `id` was written, if it was written literally.
    fn span(&self, id: &str, n: usize) -> Option<Span> {
        self.spans.get(id).and_then(|spans| spans.get(n).or(spans.last())).copied()
    }

    fn error(&mut self, code: &str, at: Option<&str>, message: String) {
        let span = at.and_then(|id| self.span(id, 0));
        self.errors.push(source(code, message, span));
    }

    fn page_name(&self, page: usize) -> String {
        format!("page {:?}", self.board.pages[page].id)
    }

    /// Every id on the board, and the duplicate-id errors.
    fn namespace(&mut self) -> HashMap<String, Entry> {
        let mut seen: HashMap<String, Entry> = HashMap::new();
        let mut occurrences: HashMap<String, usize> = HashMap::new();
        let mut declare = |r: &mut Self, id: &str, entry: Entry| {
            let n = occurrences.entry(id.to_owned()).or_insert(0);
            if let Some(first) = seen.get(id) {
                let span = r.span(id, *n);
                r.errors.push(source(
                    "duplicate-id",
                    format!(
                        "id {id:?} is used by a {} on {} and again by a {} on {}. Ids are unique across the whole board: rename one, e.g. id {:?}.",
                        first.word,
                        r.page_name(first.page),
                        entry.word,
                        r.page_name(entry.page),
                        format!("{id}-2")
                    ),
                    span,
                ));
            } else {
                seen.insert(id.to_owned(), entry);
            }
            *n += 1;
        };
        for (p, page) in self.board.pages.iter().enumerate() {
            declare(self, &page.id, Entry { word: "page", page: p, is_mark: false });
            let mut children = Vec::new();
            crate::ir::walk(&page.region, &mut |child, _| children.push(child));
            for child in children {
                declare(self, child.id(), Entry { word: child.word(), page: p, is_mark: child.is_mark() });
            }
            for c in &page.connectors {
                declare(self, &c.id, Entry { word: "connector", page: p, is_mark: false });
            }
        }
        seen
    }

    /// A section anywhere beneath another section, through groups.
    fn one_tier_of_sections(&mut self, region: &Region, inside: Option<&str>) {
        for child in &region.children {
            if let Child::Section(s) = child
                && let Some(outer) = inside
            {
                self.error(
                    "section-in-section",
                    Some(&s.id),
                    format!(
                        "section {:?} is inside section {outer:?} (through a group). A section cannot hold another section, at any depth: make the inner one a group, or move it out beside {outer:?}.",
                        s.id
                    ),
                );
            }
            let next = match child {
                Child::Section(s) => Some(s.id.as_str()),
                _ => inside,
            };
            if let Some(inner) = child.region() {
                self.one_tier_of_sections(inner, next);
            }
        }
    }

    fn endpoints(&mut self, ids: &HashMap<String, Entry>) {
        for (p, page) in self.board.pages.iter().enumerate() {
            for c in &page.connectors {
                for (end, target) in [("from", &c.from), ("to", &c.to)] {
                    let message = match ids.get(target.as_str()) {
                        None => Some((
                            "endpoint",
                            format!(
                                "connector {:?}: {end} {target:?} names nothing on the board. A connector joins two marks by their ids: give the mark `id {target:?}`, or use the id it has.",
                                c.id
                            ),
                        )),
                        Some(e) if !e.is_mark => Some((
                            "endpoint",
                            format!(
                                "connector {:?}: {end} {target:?} is a {}. A connector joins stickies, shapes and textboxes: name a mark inside it instead.",
                                c.id, e.word
                            ),
                        )),
                        Some(e) if e.page != p => Some((
                            "cross-page-endpoint",
                            format!(
                                "connector {:?} is on {} but its {end} {target:?} is a {} on {}. A connector joins marks on the same page: put the connector and both marks on one page, or connect a mark on {}.",
                                c.id,
                                self.page_name(p),
                                e.word,
                                self.page_name(e.page),
                                self.page_name(p)
                            ),
                        )),
                        Some(_) => None,
                    };
                    if let Some((code, message)) = message {
                        self.error(code, Some(&c.id), message);
                    }
                }
            }
        }
    }

    fn orders(&mut self, region: &Region, region_name: &str, ids: &HashMap<String, Entry>) {
        let siblings: Vec<&str> = region.children.iter().map(|c| c.id()).collect();
        let is_flow = matches!(region.layout, Layout::Flow { .. });
        let mut edges: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for child in &region.children {
            let before = child.before();
            if before.is_empty() {
                continue;
            }
            if !is_flow {
                let layout = match region.layout {
                    Layout::Auto => "AUTO (the default)",
                    Layout::Row => "ROW",
                    Layout::Column => "COLUMN",
                    Layout::Grid { .. } => "GRID",
                    Layout::Flow { .. } => unreachable!(),
                };
                let fix = if matches!(region.layout, Layout::Auto) {
                    "write `layout FLOW` on it to order its children by `before`, or use ROW, COLUMN or GRID, which keep the written order".to_owned()
                } else {
                    format!(
                        "{layout} already keeps the children in the order they are written, so reorder them, or choose `layout FLOW`"
                    )
                };
                self.error(
                    "before-placement",
                    Some(child.id()),
                    format!(
                        "{} {:?}: `before` is legal only on a direct child of a `layout FLOW` region, and {region_name} is {layout}: {fix}.",
                        child.word(),
                        child.id()
                    ),
                );
                continue;
            }
            for target in before {
                if target == child.id() {
                    self.error(
                        "before-reference",
                        Some(child.id()),
                        format!(
                            "{} {:?}: `before` names itself. A child comes before its siblings, not itself.",
                            child.word(),
                            child.id()
                        ),
                    );
                } else if siblings.contains(&target.as_str()) {
                    edges.entry(child.id()).or_default().push(target);
                } else {
                    let where_ = match ids.get(target.as_str()) {
                        None => "names nothing on the board".to_owned(),
                        Some(e) => format!("is a {} that is not a direct child of {region_name}", e.word),
                    };
                    self.error(
                        "before-reference",
                        Some(child.id()),
                        format!(
                            "{} {:?}: before {target:?} {where_}. `before` orders siblings in the same FLOW region: name one of {}.",
                            child.word(),
                            child.id(),
                            siblings.iter().filter(|s| **s != child.id()).map(|s| format!("{s:?}")).collect::<Vec<_>>().join(", ")
                        ),
                    );
                }
            }
        }
        if let Some(cycle) = find_cycle(&siblings, &edges) {
            let path = cycle.join(" -> ");
            let first = cycle[0];
            self.error(
                "strict-cycle",
                Some(first),
                format!(
                    "The `before` orders in {region_name} form a cycle: {path}. Strict order cannot loop. Remove `before` from one of {}; a connector can still show the return path, e.g. connector id \"{}-{}\" from {:?} to {:?} {{}}.",
                    cycle[..cycle.len() - 1].iter().map(|s| format!("{s:?}")).collect::<Vec<_>>().join(", "),
                    cycle[cycle.len() - 2],
                    cycle[cycle.len() - 1],
                    cycle[cycle.len() - 2],
                    cycle[cycle.len() - 1]
                ),
            );
        }
        for child in &region.children {
            if let Some(inner) = child.region() {
                let name = format!("{} {:?}", child.word(), child.id());
                self.orders(inner, &name, ids);
            }
        }
    }
}

/// A cycle in the strict-precedence graph, as the path that closes it (`a`, `b`, `a`). Nodes are
/// visited in declaration order, so the same program always reports the same cycle.
fn find_cycle<'a>(nodes: &[&'a str], edges: &BTreeMap<&'a str, Vec<&'a str>>) -> Option<Vec<&'a str>> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        New,
        Open,
        Done,
    }
    fn visit<'a>(
        n: &'a str,
        edges: &BTreeMap<&'a str, Vec<&'a str>>,
        marks: &mut HashMap<&'a str, Mark>,
        stack: &mut Vec<&'a str>,
    ) -> Option<Vec<&'a str>> {
        marks.insert(n, Mark::Open);
        stack.push(n);
        for &next in edges.get(n).map(Vec::as_slice).unwrap_or_default() {
            match marks.get(next).copied().unwrap_or(Mark::New) {
                Mark::Open => {
                    let start = stack.iter().position(|s| *s == next).expect("on the stack");
                    let mut cycle = stack[start..].to_vec();
                    cycle.push(next);
                    return Some(cycle);
                }
                Mark::New => {
                    if let Some(cycle) = visit(next, edges, marks, stack) {
                        return Some(cycle);
                    }
                }
                Mark::Done => {}
            }
        }
        stack.pop();
        marks.insert(n, Mark::Done);
        None
    }
    let mut marks = HashMap::new();
    for &n in nodes {
        if marks.get(n).copied().unwrap_or(Mark::New) == Mark::New {
            let mut stack = Vec::new();
            if let Some(cycle) = visit(n, edges, &mut marks, &mut stack) {
                return Some(cycle);
            }
        }
    }
    None
}

/// Every resolution error on the board, in a fixed order.
pub fn resolve(board: &Board, spans: &SourceMap) -> Vec<Diagnostic> {
    let mut r = Resolver { board, spans, errors: Vec::new() };
    if board.pages.is_empty() {
        r.error(
            "empty-board",
            None,
            "A board needs at least one page, e.g. board [ page [ ] id \"p1\" name \"Page 1\" {} ] {}.".to_owned(),
        );
        return r.errors;
    }
    if board.pages.len() > 1 && !board.show_page_tabs && !board.show_page_menu {
        r.error(
            "page-navigation",
            None,
            "A board with more than one page cannot hide both its page tabs and its page menu: drop `show-page-tabs false` or write `show-page-menu true`.".to_owned(),
        );
    }
    let ids = r.namespace();
    for page in &board.pages {
        r.one_tier_of_sections(&page.region, None);
    }
    r.endpoints(&ids);
    for page in &board.pages {
        let name = format!("page {:?}", page.id);
        r.orders(&page.region, &name, &ids);
    }
    r.errors
}
