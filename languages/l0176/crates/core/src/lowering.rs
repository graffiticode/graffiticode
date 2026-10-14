// SPDX-License-Identifier: MIT

//! Lowers the legacy save member to the explicit save, before checking or admission sees the
//! program:
//!
//! ```text
//! items [save-to-itembank true, item [...]] {}   →   save-to-itembank items [item [...]] {}
//! questions [save-to-itembank true, mcq []] {}    →   save-to-itembank questions [mcq []] {}
//! ```
//!
//! Only the literal form is lowered: a `SAVE_TO_ITEMBANK` whose argument is a `BOOL` node,
//! written directly in the list of an `ITEMS` or `QUESTIONS` node. `save-to-itembank false` is
//! removed. Anything else that sets the flag is left alone and refused when it is evaluated, so
//! the only node that writes is `SAVE_TO_ITEMBANK` wrapping an activity — the node admission
//! sees and the write happens in.
//!
//! The input pool is not changed; rewritten nodes get fresh ids, so a node the parser shares
//! between several parents is never edited in place.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value as Json, json};

const LEAF_TAGS: &[&str] = &["NUM", "STR", "IDENT", "BOOL", "TAG", "NULL"];

fn tag(node: &Json) -> Option<&str> {
    node.get("tag").and_then(Json::as_str)
}

fn elts(node: &Json) -> Vec<Json> {
    node.get("elts").and_then(Json::as_array).cloned().unwrap_or_default()
}

/// The node an element names, if it names one.
fn at<'a>(pool: &'a Map<String, Json>, nid: &Json) -> Option<&'a Json> {
    pool.get(&id_of(nid)?.to_string())
}

fn id_of(nid: &Json) -> Option<u64> {
    nid.as_u64()
}

pub fn lower_legacy_save(code: &Json) -> Cow<'_, Json> {
    let Json::Object(original) = code else { return Cow::Borrowed(code) };
    let mut pool = original.clone();
    let keys: Vec<String> = pool.keys().filter(|key| *key != "root").cloned().collect();
    let mut next = keys.iter().filter_map(|key| key.parse::<u64>().ok()).max().unwrap_or(0) + 1;
    let mut replace: HashMap<u64, u64> = HashMap::new();
    let mut orphans: Vec<u64> = Vec::new();

    for key in &keys {
        let Some(node) = pool.get(key).cloned() else { continue };
        if !matches!(tag(&node), Some("ITEMS" | "QUESTIONS")) {
            continue;
        }
        let node_elts = elts(&node);
        let Some(list_nid) = node_elts.first().cloned() else { continue };
        let Some(list) = at(&pool, &list_nid).filter(|list| tag(list) == Some("LIST")).cloned() else { continue };
        let saves: Vec<Json> = elts(&list)
            .into_iter()
            .filter(|nid| {
                at(&pool, nid).is_some_and(|member| {
                    tag(member) == Some("SAVE_TO_ITEMBANK")
                        && elts(member).first().and_then(|arg| at(&pool, arg)).and_then(tag) == Some("BOOL")
                })
            })
            .collect();
        let Some(last_nid) = saves.last() else { continue };
        // Members merge last-wins, so the last literal decides.
        let last = at(&pool, last_nid).cloned().unwrap_or(Json::Null);
        let flag = elts(&last).first().and_then(|arg| at(&pool, arg)).map(elts).and_then(|e| e.first().cloned());
        let save = flag == Some(Json::Bool(true));

        let list_id = next;
        next += 1;
        let kept: Vec<Json> = elts(&list).into_iter().filter(|nid| !saves.contains(nid)).collect();
        pool.insert(list_id.to_string(), json!({ "tag": "LIST", "elts": kept }));
        let activity_id = next;
        next += 1;
        let mut activity = node.clone();
        let mut activity_elts = vec![json!(list_id)];
        activity_elts.extend(node_elts.into_iter().skip(1));
        activity["elts"] = Json::Array(activity_elts);
        pool.insert(activity_id.to_string(), activity);
        let replacement = if save {
            let wrapper_id = next;
            next += 1;
            let mut wrapper = json!({ "tag": "SAVE_TO_ITEMBANK", "elts": [activity_id] });
            if let Some(coord) = last.get("coord") {
                wrapper["coord"] = coord.clone();
            }
            pool.insert(wrapper_id.to_string(), wrapper);
            wrapper_id
        } else {
            activity_id
        };
        let Ok(key) = key.parse::<u64>() else { continue };
        replace.insert(key, replacement);
        orphans.push(key);
        orphans.extend(id_of(&list_nid));
        orphans.extend(saves.iter().filter_map(id_of));
    }
    if replace.is_empty() {
        return Cow::Borrowed(code);
    }

    let redirect = |nid: &Json| match id_of(nid).and_then(|id| replace.get(&id)) {
        Some(to) => json!(to),
        None => nid.clone(),
    };
    for (key, node) in pool.iter_mut() {
        if key == "root" || tag(node).is_some_and(|tag| LEAF_TAGS.contains(&tag)) {
            continue;
        }
        if let Some(Json::Array(children)) = node.get_mut("elts") {
            for child in children.iter_mut() {
                if child.is_number() {
                    *child = redirect(child);
                }
            }
        }
    }
    if let Some(root) = pool.get("root").cloned() {
        pool.insert("root".into(), redirect(&root));
    }

    // Drop what was replaced, and the legacy members, once nothing reachable refers to them,
    // so the member form never remains in the pool.
    let mut reachable = HashSet::new();
    let mut stack: Vec<Json> = pool.get("root").cloned().into_iter().collect();
    while let Some(nid) = stack.pop() {
        let Some(id) = id_of(&nid) else { continue };
        if !reachable.insert(id) {
            continue;
        }
        if let Some(node) = pool.get(&id.to_string())
            && !tag(node).is_some_and(|tag| LEAF_TAGS.contains(&tag))
        {
            stack.extend(elts(node).into_iter().filter(Json::is_number));
        }
    }
    for nid in orphans {
        if reachable.contains(&nid) {
            continue;
        }
        let member = pool.remove(&nid.to_string());
        let arg = member
            .filter(|member| tag(member) == Some("SAVE_TO_ITEMBANK"))
            .and_then(|member| elts(&member).first().and_then(id_of));
        if let Some(arg) = arg
            && !reachable.contains(&arg)
            && pool.get(&arg.to_string()).and_then(tag) == Some("BOOL")
        {
            pool.remove(&arg.to_string());
        }
    }
    Cow::Owned(Json::Object(pool))
}
