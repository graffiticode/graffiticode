// SPDX-License-Identifier: MIT

//! Assembling a concept web: ids, edge references, blanks, trays, pools — and every error those
//! produce. The words hand this the evaluated descriptions; nothing here walks an AST.
//!
//! The output is `@graffiticode/learnosity-cqt`'s cell-scoring contract (see `CLAUDE.md`, "The
//! output contract"): `interaction.cells` holds one entry per blank with the learner's `value`,
//! `validation.cells` the answer key, its pool and its tray, `validation.distractors` what each
//! distractor costs.
//!
//! The descriptions are plain JSON and may come from record literals as well as from words, so
//! every read here is JavaScript's: a missing field is `undefined`, `??` falls back on null
//! too, a comparison is `===`, and a field read on nothing fails with Node's `TypeError`.

use indexmap::IndexMap;
use serde_json::{Value as Json, json};

use crate::attributes::{assert_known_attributes, merge_attributes};
use crate::js::{
    self, Object, add, cannot_read, entries, get, join, js_string, or_else, show_value, strict_eq, stringify,
    to_number, truthy,
};
use crate::text;

pub const HUB_ID: &str = "hub";

const NODE_EXAMPLE: &str = "node text \"Nucleus\" {}";
const BLANK_EXAMPLE: &str = "node text \"Nucleus\" assess [expected] {}";
const EDGE_EXAMPLE: &str = "edge from \"hub\" to \"Nucleus\" label \"contains\" {}";

/// What `assess [...]` says: a blank worth `points`, or a distractor costing `points`.
struct Assess {
    expected: bool,
    points: Json,
}

fn read_assess(raw: Option<&Json>, at: &str) -> Result<Assess, String> {
    let within = format!("{at}: assess");
    let a = Json::Object(merge_attributes(raw, &within, "assess [expected]")?);
    assert_known_attributes("assess", Some(&a), &within)?;
    let (expected, distractor) = (truthy(a.get("expected")), truthy(a.get("distractor")));
    if expected && distractor {
        return Err(format!(
            "{at}: assess has both `expected` and `distractor`. A blank is filled with its own answer; a distractor is a wrong answer in the tray. Keep one."
        ));
    }
    if !expected && !distractor {
        return Err(format!(
            "{at}: assess needs `expected` (a blank, answered by its own text) or `distractor` (a wrong answer in the tray), e.g. assess [expected] or assess [distractor points -1]."
        ));
    }
    if expected {
        let points = or_else(a.get("points").cloned(), || json!(1));
        let above = to_number(Some(&points)) > 0.0; // NaN is neither
        if !above {
            return Err(format!(
                "{at}: `points` on a blank must be above 0, got {}. A negative `points` belongs on a distractor.",
                show_value(Some(&points))
            ));
        }
        return Ok(Assess { expected: true, points });
    }
    let points = or_else(a.get("points").cloned(), || json!(0));
    let at_most = to_number(Some(&points)) <= 0.0;
    if !at_most {
        return Err(format!(
            "{at}: `points` on a distractor must be 0 or below — it is what dropping it on a blank costs. Got {}.",
            show_value(Some(&points))
        ));
    }
    Ok(Assess { expected: false, points })
}

/// A distractor is only a tray item, so every other word on it would silently do nothing.
fn assert_distractor_only(attrs: Option<&Json>, answer: &str, at: &str) -> Result<(), String> {
    if let Some(extra) = js::keys(attrs)?.into_iter().find(|k| k != answer && k != "assess") {
        return Err(format!(
            "{at}: a distractor sits only in the tray and is not drawn, so it takes just `{answer}` and `assess` — drop `{extra}`."
        ));
    }
    Ok(())
}

/// `value.trim()` on a field, as the TypeScript calls it: a TypeError on anything but a string.
fn trimmed_is_empty(value: Option<&Json>, expression: &str) -> Result<bool, String> {
    match value {
        Some(Json::String(text)) => Ok(text::trim(text).is_empty()),
        None | Some(Json::Null) => Err(cannot_read(value, "trim")),
        Some(_) => Err(format!("{expression}.trim is not a function")),
    }
}

struct Key {
    expected: Json,
    points: Json,
}

enum Read {
    Placed { placed: Object, text: Option<Json>, key: Option<Key> },
    Distractor { text: Json, points: Json },
}

/// One node (or the hub). A blank's text is its answer: moved into the key and stripped from
/// the drawn node. A distractor is a wrong answer in the tray, not drawn.
fn read_node(attrs: Option<&Json>, at: &str, example: &str) -> Result<Read, String> {
    // Only ever called on a description `Object.keys` has already accepted, so never on nothing.
    let mut rest = attrs.map(entries).unwrap_or_default();
    let assess = rest.shift_remove("assess");
    let Some(text) = rest.get("text").cloned() else {
        return Err(format!("{at}: needs `text`, e.g. {example}."));
    };
    let Some(assess) = assess else {
        return Ok(Read::Placed { placed: rest, text: Some(text), key: None });
    };
    let a = read_assess(Some(&assess), at)?;
    if trimmed_is_empty(Some(&text), "rest.text")? {
        return Err(format!("{at}: an assessed node's `text` is its answer, so it must not be empty."));
    }
    if !a.expected {
        assert_distractor_only(attrs, "text", at)?;
        return Ok(Read::Distractor { text, points: a.points });
    }
    rest.shift_remove("text");
    rest.insert("blank".into(), json!(true));
    Ok(Read::Placed { placed: rest, text: Some(text.clone()), key: Some(Key { expected: text, points: a.points }) })
}

/// A node as an edge can name it: by id, or by its text — a blank's too, though it is hidden.
struct Ref {
    id: Json,
    text: Option<Json>,
}

/// Resolve an edge endpoint: a node's id first, then its exact text. A reference that names
/// nothing, or names two nodes, is an error.
fn resolve_ref(reference: &Json, nodes: &[Ref], at: &str, word: &str) -> Result<Json, String> {
    if let Some(by_id) = nodes.iter().find(|n| strict_eq(Some(&n.id), Some(reference))) {
        return Ok(by_id.id.clone());
    }
    let by_text: Vec<&Ref> = nodes.iter().filter(|n| strict_eq(n.text.as_ref(), Some(reference))).collect();
    let written = stringify(reference);
    match by_text.as_slice() {
        [one] => Ok(one.id.clone()),
        [] => {
            let known: Vec<String> = nodes
                .iter()
                .map(|n| match &n.text {
                    Some(text) => format!("{} ({})", js_string(&n.id), stringify(text)),
                    None => js_string(&n.id),
                })
                .collect();
            Err(format!(
                "{at}: `{word} {written}` names no node. Refer to a node by its id or its exact text. The nodes are: {}. A distractor is not drawn and cannot be joined.",
                known.join(", ")
            ))
        }
        many => Err(format!(
            "{at}: `{word} {written}` matches {} nodes with that text. Give the one you mean an `id` and refer to it by that.",
            many.len()
        )),
    }
}

/// Pools: which blanks accept each other's answers. Two blanks whose places in the web are
/// indistinguishable — same kind, the same edges to the same neighbours drawn the same way —
/// share a pool, and the scorer matches answers across the pool as a whole.
fn assign_pools(hub: &Object, edges: &[Object], keyed: &[Json]) -> IndexMap<String, String> {
    let edge_side = |e: &Object, dir: &str, other: Option<&Json>| {
        let label = if truthy(e.get("blank")) {
            json!(format!("?{}", js::js_string_or_undefined(e.get("id"))))
        } else {
            or_else(e.get("label").cloned(), || json!(""))
        };
        let dir = json!(dir);
        join([Some(&dir), e.get("style"), Some(&label), other].into_iter(), "|")
    };
    let signature = |id: &Json| -> String {
        if let Some(edge) = edges.iter().find(|e| strict_eq(e.get("id"), Some(id))) {
            let kind = json!("edge");
            return join([Some(&kind), edge.get("from"), edge.get("to"), edge.get("style")].into_iter(), "|");
        }
        let kind = if strict_eq(Some(id), hub.get("id")) { "hub" } else { "node" };
        let mut sides: Vec<String> = edges
            .iter()
            .filter_map(|e| {
                if strict_eq(e.get("from"), Some(id)) {
                    Some(edge_side(e, "out", e.get("to")))
                } else if strict_eq(e.get("to"), Some(id)) {
                    Some(edge_side(e, "in", e.get("from")))
                } else {
                    None
                }
            })
            .collect();
        sides.sort_by(|a, b| js::utf16_cmp(a, b));
        std::iter::once(kind.to_owned()).chain(sides).collect::<Vec<_>>().join("\n")
    };
    let mut pools = IndexMap::new();
    let mut by_signature: IndexMap<String, String> = IndexMap::new();
    for id in keyed {
        let sig = signature(id);
        let next = format!("p{}", by_signature.len() + 1);
        let pool = by_signature.entry(sig).or_insert(next).clone();
        pools.insert(js_string(id), pool);
    }
    pools
}

struct Tray {
    tray: Option<Json>,
    costs: Option<Object>,
}

/// A tray: every answer the blanks expect, plus the distractors. Shuffled by the view.
fn build_tray(
    answers: &[Json],
    distractors: &[(Json, Json)],
    settings: Option<&Json>,
    prefix: &str,
    container: &str,
    default_align: &str,
) -> Result<Tray, String> {
    let member = if container == "nodes" { "node" } else { "edge" };
    let mut costs = Object::new();
    for (text, points) in distractors {
        if answers.iter().any(|answer| strict_eq(Some(answer), Some(text))) {
            return Err(format!(
                "{container}: distractor {} is also a correct answer. A distractor must be wrong — change or drop it.",
                stringify(text)
            ));
        }
        let key = js_string(text);
        if costs.contains_key(&key) {
            return Err(format!("{container}: distractor {} is given twice. Each may appear once.", stringify(text)));
        }
        costs.insert(key, points.clone());
    }
    if answers.is_empty() {
        if !distractors.is_empty() {
            return Err(format!(
                "{container}: has a distractor but no blanks. Distractors join a tray of answers — give at least one {member} `assess [expected]`."
            ));
        }
        return Ok(Tray { tray: None, costs: None });
    }
    let texts = answers.iter().chain(distractors.iter().map(|(text, _)| text));
    let items: Vec<Json> =
        texts.enumerate().map(|(i, text)| json!({ "id": format!("{prefix}{}", i + 1), "text": text })).collect();
    if matches!(settings, None | Some(Json::Null)) {
        return Err(cannot_read(settings, "trayAlign"));
    }
    let align = get(settings, "trayAlign").filter(|align| truthy(Some(align))).unwrap_or_else(|| json!(default_align));
    Ok(Tray {
        tray: Some(json!({ "items": items, "align": align })),
        costs: (!distractors.is_empty()).then_some(costs),
    })
}

/// The learner's state as it reaches the compiler through the platform API may be L0000's
/// `{data, errors}` envelope, nested after a round trip. Unwrap until the model shows.
fn unwrap_envelope(mut value: Option<Json>) -> Option<Json> {
    while let Some(Json::Object(object)) = &value {
        if !object.get("errors").is_some_and(Json::is_array) {
            break;
        }
        value = object.get("data").cloned();
    }
    value
}

/// `members.items.forEach(...)`: the descriptions of a member list.
fn items(members: Option<&Json>, name: &str) -> Result<Vec<Json>, String> {
    if matches!(members, None | Some(Json::Null)) {
        return Err(cannot_read(members, "items"));
    }
    match get(members, "items") {
        Some(Json::Array(items)) => Ok(items),
        None => Err(cannot_read(None, "forEach")),
        Some(_) => Err(format!("{name}.items.forEach is not a function")),
    }
}

/// Build the compiled model from `concept-web`'s merged children and its settings. `data` is
/// the learner's state carried back on a recompile; exactly one thing is taken from it, each
/// blank's `value`.
pub fn build_web(web: &Object, settings: &Object, data: Option<Json>) -> Result<Json, String> {
    let Some(hub_attrs) = web.get("hub") else {
        return Err("concept-web: needs a `hub`, the node at the centre, e.g. concept-web [ hub text \"The Cell\" {} nodes [ … ] {} ] {}.".to_owned());
    };
    let Some(node_members) = web.get("nodes") else {
        return Err("concept-web: needs `nodes`, the nodes around the hub, e.g. nodes [ node text \"Nucleus\" {} node text \"Ribosome\" {} ] {}.".to_owned());
    };
    let mut keys: IndexMap<String, Key> = IndexMap::new();

    // The hub.
    assert_known_attributes("hub", Some(hub_attrs), "hub")?;
    let Read::Placed { placed, text, key } = read_node(Some(hub_attrs), "hub", "hub text \"The Cell\" {}")? else {
        return Err("hub: cannot be a distractor — the hub is always drawn. Use assess [expected] to make it a blank."
            .to_owned());
    };
    let mut hub = Object::new();
    hub.insert("id".into(), json!(HUB_ID));
    hub.extend(placed);
    if let Some(key) = key {
        keys.insert(HUB_ID.into(), key);
    }
    let mut refs = vec![Ref { id: json!(HUB_ID), text }];

    // Nodes: ids are the author's, else n1, n2, … counting the drawn nodes.
    let mut nodes: Vec<Object> = Vec::new();
    let mut node_distractors: Vec<(Json, Json)> = Vec::new();
    for (i, attrs) in items(Some(node_members), "nodeMembers")?.iter().enumerate() {
        let at = format!("node {}", i + 1);
        assert_known_attributes("node", Some(attrs), &at)?;
        match read_node(Some(attrs), &at, if i > 0 { BLANK_EXAMPLE } else { NODE_EXAMPLE })? {
            Read::Distractor { text, points } => node_distractors.push((text, points)),
            Read::Placed { placed, text, key } => {
                let id = or_else(placed.get("id").cloned(), || json!(format!("n{}", nodes.len() + 1)));
                if let Some(key) = key {
                    keys.insert(js_string(&id), key);
                }
                let mut node = Object::new();
                node.insert("id".into(), id.clone());
                node.extend(placed);
                nodes.push(node);
                refs.push(Ref { id, text });
            }
        }
    }
    if nodes.is_empty() {
        return Err(format!("nodes: needs at least one drawn node, e.g. nodes [ {NODE_EXAMPLE} ] {{}}."));
    }
    let mut seen: Vec<Option<Json>> = vec![Some(json!(HUB_ID))];
    let has = |seen: &[Option<Json>], id: Option<&Json>| seen.iter().any(|s| strict_eq(s.as_ref(), id));
    for n in &nodes {
        let id = n.get("id");
        if has(&seen, id) {
            return Err(if strict_eq(id, Some(&json!(HUB_ID))) {
                "nodes: the id \"hub\" is taken by the hub. Give this node another id.".to_owned()
            } else {
                format!(
                    "nodes: two nodes have the id {}. Every id must be different.",
                    id.map_or_else(|| "undefined".to_owned(), stringify)
                )
            });
        }
        seen.push(id.cloned());
    }

    // Edges: given, or a spoke from the hub to every node.
    let mut edges: Vec<Object> = Vec::new();
    let mut edge_distractors: Vec<(Json, Json)> = Vec::new();
    let edge_members = web.get("edges");
    match edge_members {
        None => {
            for (i, n) in nodes.iter().enumerate() {
                let to = n.get("id").cloned();
                let mut edge = Object::new();
                edge.insert("id".into(), json!(format!("e{}", i + 1)));
                edge.insert("from".into(), json!(HUB_ID));
                if let Some(to) = to {
                    edge.insert("to".into(), to);
                }
                edge.insert("style".into(), json!("solid"));
                edges.push(edge);
            }
        }
        Some(members) => {
            for (i, attrs) in items(Some(members), "edgeMembers")?.iter().enumerate() {
                let at = format!("edge {}", i + 1);
                assert_known_attributes("edge", Some(attrs), &at)?;
                let mut rest = entries(attrs);
                let assess = rest.shift_remove("assess");
                let from = rest.shift_remove("from");
                let to = rest.shift_remove("to");
                let a = assess.map(|assess| read_assess(Some(&assess), &at)).transpose()?;
                let label = rest.get("label").cloned();
                if a.is_some() && label.is_none() {
                    return Err(format!(
                        "{at}: an assessed edge needs `label` — its answer, e.g. edge from \"hub\" to \"Nucleus\" label \"contains\" assess [expected] {{}}."
                    ));
                }
                if let Some(Assess { expected: false, points }) = &a {
                    assert_distractor_only(Some(attrs), "label", &at)?;
                    edge_distractors.push((label.expect("checked above"), points.clone()));
                    continue;
                }
                let (Some(from), Some(to)) = (from, to) else {
                    return Err(format!("{at}: needs both `from` and `to`, e.g. {EDGE_EXAMPLE}."));
                };
                let id = or_else(rest.get("id").cloned(), || json!(format!("e{}", edges.len() + 1)));
                let from = resolve_ref(&from, &refs, &at, "from")?;
                let to = resolve_ref(&to, &refs, &at, "to")?;
                let style = or_else(rest.get("style").cloned(), || json!("solid"));
                if strict_eq(Some(&from), Some(&to)) {
                    return Err(format!("{at}: goes from a node to itself. An edge joins two different nodes."));
                }
                let mut edge = Object::new();
                edge.insert("id".into(), id.clone());
                edge.insert("from".into(), from);
                edge.insert("to".into(), to);
                edge.insert("style".into(), style);
                if let Some(a) = a {
                    if trimmed_is_empty(label.as_ref(), "rest.label")? {
                        return Err(format!(
                            "{at}: an assessed edge's `label` is its answer, so it must not be empty."
                        ));
                    }
                    edge.insert("blank".into(), json!(true));
                    let expected = label.expect("checked above");
                    keys.insert(js_string(&id), Key { expected, points: a.points });
                } else if let Some(label) = label {
                    edge.insert("label".into(), label);
                }
                edges.push(edge);
            }
            let mut edge_ids: Vec<Option<Json>> = Vec::new();
            for e in &edges {
                let id = e.get("id");
                if has(&edge_ids, id) || has(&seen, id) {
                    return Err(format!(
                        "edges: the id {} is used twice. Every node and edge id must be different.",
                        id.map_or_else(|| "undefined".to_owned(), stringify)
                    ));
                }
                edge_ids.push(id.cloned());
            }
        }
    }

    // Trays and the answer key.
    let blank_ids = |members: &mut dyn Iterator<Item = &Object>| -> Vec<Json> {
        members.filter(|m| truthy(m.get("blank"))).map(|m| m.get("id").cloned().unwrap_or(Json::Null)).collect()
    };
    let node_blanks = blank_ids(&mut std::iter::once(&hub).chain(nodes.iter()));
    let edge_blanks = blank_ids(&mut edges.iter());
    let key_of = |id: &Json| keys.get(&js_string(id)).ok_or_else(|| cannot_read(None, "expected"));
    let expected = |ids: &[Json]| -> Result<Vec<Json>, String> {
        ids.iter().map(|id| key_of(id).map(|key| key.expected.clone())).collect()
    };
    let node_tray = build_tray(
        &expected(&node_blanks)?,
        &node_distractors,
        get(Some(node_members), "settings").as_ref(),
        "c",
        "nodes",
        "right",
    )?;
    let edge_settings = get(edge_members, "settings").filter(|s| truthy(Some(s))).unwrap_or_else(|| json!({}));
    let edge_tray =
        build_tray(&expected(&edge_blanks)?, &edge_distractors, Some(&edge_settings), "r", "edges", "bottom")?;
    let mut tray_of: IndexMap<String, &str> = IndexMap::new();
    for id in &node_blanks {
        tray_of.insert(js_string(id), "nodes");
    }
    for id in &edge_blanks {
        tray_of.insert(js_string(id), "edges");
    }
    let blanks: Vec<Json> = node_blanks.iter().chain(edge_blanks.iter()).cloned().collect();
    let pools = assign_pools(&hub, &edges, &blanks);

    let model = unwrap_envelope(data);
    let cells_given = get(get(model.as_ref(), "interaction").as_ref(), "cells");
    let answered = cells_given.filter(|cells| truthy(Some(cells))).unwrap_or_else(|| json!({}));
    let mut cells = Object::new();
    let mut key_cells = Object::new();
    let mut points = json!(0);
    for id in &blanks {
        let name = js_string(id);
        let value = get(get(Some(&answered), &name).as_ref(), "value");
        cells.insert(
            name.clone(),
            match value {
                Some(value @ Json::String(_)) => json!({ "value": value }),
                _ => json!({}),
            },
        );
        let key = key_of(id)?;
        key_cells.insert(
            name.clone(),
            json!({
                "assess": { "expected": key.expected, "points": key.points },
                "pool": pools.get(&name),
                "tray": tray_of.get(&name),
            }),
        );
        points = add(&points, Some(&key.points));
    }
    let mut distractors = Object::new();
    if let Some(costs) = node_tray.costs {
        distractors.insert("nodes".into(), Json::Object(costs));
    }
    if let Some(costs) = edge_tray.costs {
        distractors.insert("edges".into(), Json::Object(costs));
    }

    let mut out = Object::new();
    for field in ["title", "instructions", "theme"] {
        if let Some(value) = settings.get(field) {
            out.insert(field.into(), value.clone());
        }
    }
    if let Some(instant) = settings.get("instantFeedback") {
        out.insert("feedback".into(), json!(if truthy(Some(instant)) { "instant" } else { "check" }));
    }
    let mut trays = Object::new();
    if let Some(tray) = node_tray.tray {
        trays.insert("nodes".into(), tray);
    }
    if let Some(tray) = edge_tray.tray {
        trays.insert("edges".into(), tray);
    }
    out.insert(
        "interaction".into(),
        json!({
            "type": "concept-web",
            "hub": hub,
            "nodes": nodes,
            "edges": edges,
            "trays": trays,
            "cells": cells,
        }),
    );
    let mut validation = Object::new();
    validation.insert("points".into(), points);
    validation.insert("cells".into(), Json::Object(key_cells));
    if !distractors.is_empty() {
        validation.insert("distractors".into(), Json::Object(distractors));
    }
    out.insert("validation".into(), Json::Object(validation));
    Ok(js::js_order(Json::Object(out)))
}
