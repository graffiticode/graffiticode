// SPDX-License-Identifier: MIT

//! The two activities a program builds, `questions [...] {}` and `items [...] {}`, each with the
//! plan an item-bank save would write beside it. Building never writes: the write is
//! `save-to-itembank`'s alone, and happens only in the broker.
//!
//! Both render the same way, through the Questions API with the question data inline and keyed
//! by `response_id`. The item bank takes a different shape, `{type, reference, data}` records,
//! which is what a save plan holds.

use graffiticode_l0000::canonical::args_digest;
use serde_json::{Value as Json, json};

use crate::plain::{Object, js_string};

/// A built activity and what saving it would write.
pub struct Built {
    pub activity: Object,
    pub save_plan: Json,
}

/// `{{name}}` is a template variable, written `{{var:name}}` in Learnosity, except
/// `{{response}}`, which is a cloze blank.
fn variable_refs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("{{") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        out.push_str(if after.starts_with("response}}") { "{{" } else { "{{var:" });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Rewrites every string in a question, at any depth, as [`variable_refs`] says.
fn fix_variable_refs(json: &mut Json) {
    match json {
        Json::String(text) => *text = variable_refs(text),
        Json::Array(items) => items.iter_mut().for_each(fix_variable_refs),
        Json::Object(object) => object.values_mut().for_each(fix_variable_refs),
        _ => {}
    }
}

/// `questions [...] {}`: the questions as one activity.
pub fn create_questions(questions: Vec<Json>, id: &str) -> Built {
    // A dynamic-data table comes from the first question that carries one (typically an
    // embedded L0179 custom question).
    let template_variables = questions.iter().find_map(|question| {
        question
            .get("data")?
            .get("templateVariablesRecords")
            .filter(|records| records.as_array().is_some_and(|r| !r.is_empty()))
            .cloned()
    });
    let records: Vec<Json> = questions
        .into_iter()
        .enumerate()
        .map(|(index, mut question)| {
            let kind = question.get("type").cloned().unwrap_or(Json::Null);
            let reference = format!("artcompiler-{}-{id}-{index}", js_string(&kind));
            if question.is_object() {
                fix_variable_refs(&mut question);
            }
            json!({ "type": kind, "reference": reference, "data": question })
        })
        .collect();
    let refs: Vec<Json> = records.iter().map(|record| record["reference"].clone()).collect();
    let inline: Vec<Json> = records
        .iter()
        .map(|record| {
            let mut question = Object::new();
            question.insert("response_id".into(), record["reference"].clone());
            question.insert("type".into(), record["type"].clone());
            if let Json::Object(data) = &record["data"] {
                question.extend(data.clone());
            }
            Json::Object(question)
        })
        .collect();
    let mut activity = Object::new();
    activity.insert("type".into(), json!("questions"));
    activity.insert("data".into(), json!({ "name": "Test", "questions": &inline }));
    if let Some(records) = template_variables {
        activity.insert("templateVariablesRecords".into(), records);
    }
    activity.insert("questionRefs".into(), Json::Array(refs));
    // The activity's id is generated from its own unsigned content (C6 part 2, decision 3):
    // the same program gives the same id on every compile, so a cached result and its parity
    // are stable, and any change to the content changes it. It carries no `session_id`: Broker
    // sets the signed request's own, fresh for every signature.
    let id = format!("graffiticode-{}", &args_digest(&Json::Object(activity.clone()))[..16]);
    let mut data = Object::new();
    data.insert("id".into(), json!(id));
    data.insert("name".into(), json!("Test"));
    data.insert("questions".into(), json!(inline));
    activity.insert("data".into(), Json::Object(data));
    Built { activity, save_plan: json!({ "questionRecords": records, "itemRecords": [] }) }
}

/// The keys and values JavaScript's `Object.keys` and `Object.values` give a row.
fn entries(row: &Json) -> Result<Vec<(String, Json)>, String> {
    Ok(match row {
        Json::Object(object) => object.iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Json::Array(items) => items.iter().enumerate().map(|(i, value)| (i.to_string(), value.clone())).collect(),
        Json::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), json!(String::from_utf16_lossy(&[unit]))))
            .collect(),
        Json::Null => return Err("Cannot convert undefined or null to object".to_owned()),
        _ => Vec::new(),
    })
}

/// A dynamic-content table, from rows of named values: column names from the first row, and
/// each row's values under a reference unique to this build.
fn dynamic_content(rows: Option<&Json>) -> Result<Option<Json>, String> {
    let Some(rows) = rows.filter(|rows| crate::plain::truthy(Some(rows))) else { return Ok(None) };
    let Json::Array(rows) = rows else { return Err("data.forEach is not a function".to_owned()) };
    // The table's own digest, not the time: the same rows give the same references on every
    // run, so a retried or resumed save sends the same payload (C6 plan, decision 2). Rows keep
    // their order and their duplicates (`-row-<i>`): the View samples over row ids.
    let reference = format!("graffiticode-{}", &args_digest(&Json::Array(rows.clone()))[..16]);
    let mut cols = None;
    let mut table = Object::new();
    for (i, row) in rows.iter().enumerate() {
        let entries = entries(row)?;
        cols.get_or_insert_with(|| entries.iter().map(|(key, _)| json!(key)).collect::<Vec<_>>());
        let values: Vec<Json> = entries.into_iter().map(|(_, value)| value).collect();
        table.insert(format!("{reference}-row-{i}"), json!({ "values": values, "index": i }));
    }
    let mut out = Object::new();
    if let Some(cols) = cols {
        out.insert("cols".into(), Json::Array(cols));
    }
    out.insert("rows".into(), Json::Object(table));
    Ok(Some(Json::Object(out)))
}

/// Item-level metadata routed to the item record's fields: `tags` faceted (each value a list of
/// strings), `notes` to `note`, `description` and `source` to themselves, `difficulty-level` to
/// `adaptive.difficulty`, and `acknowledgements` into the `metadata` bag.
fn item_metadata(metadata: Option<&Json>, record: &mut Object) {
    let Some(Json::Object(metadata)) = metadata else { return };
    let mut tags = Object::new();
    let given = match metadata.get("tags") {
        Some(tags) if !tags.is_null() => entries(tags).unwrap_or_default(),
        _ => Vec::new(),
    };
    for (kind, raw) in given {
        if raw.is_null() {
            continue;
        }
        let values = match raw {
            Json::Array(values) => values,
            one => vec![one],
        };
        tags.insert(kind, values.iter().map(|value| json!(js_string(value))).collect());
    }
    if !tags.is_empty() {
        record.insert("tags".into(), Json::Object(tags));
    }
    for (from, to) in [("notes", "note"), ("description", "description"), ("source", "source")] {
        if let Some(value) = metadata.get(from) {
            record.insert(to.into(), value.clone());
        }
    }
    if let Some(difficulty) = metadata.get("difficulty_level") {
        record.insert("adaptive".into(), json!({ "difficulty": difficulty }));
    }
    if let Some(acknowledgements) = metadata.get("acknowledgements") {
        record.insert("metadata".into(), json!({ "acknowledgements": acknowledgements }));
    }
}

/// `items [...] {}`: one item record per entry. Rendering flattens every item's questions into
/// one Questions API activity.
pub fn create_items(items: &[Json], params: Option<&Json>, id: &str) -> Result<Built, String> {
    // An embedded L0179 question's table wins over a declared one; Learnosity attaches one table
    // per rendered activity.
    let inherited = items
        .iter()
        .filter_map(|item| item.get("templateVariablesRecords"))
        .find(|records| records.as_array().is_some_and(|r| !r.is_empty()));
    let dynamic = dynamic_content(inherited.or(params))?;

    let mut records = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(Json::Array(questions)) = item.get("data").and_then(|data| data.get("questions")) else {
            return Err("Cannot read properties of undefined (reading 'map')".to_owned());
        };
        // The item ordinal goes into each question's id: two items each leading with an mcq
        // would otherwise both produce `…-mcq-t-0`.
        let questions: Vec<Json> = questions
            .iter()
            .enumerate()
            .map(|(q_index, question)| {
                let mut question = question.as_object().cloned().unwrap_or_default();
                let kind = js_string(question.get("type").unwrap_or(&Json::Null));
                question.insert("response_id".into(), json!(format!("artcompiler-{kind}-{id}-{index}-{q_index}")));
                Json::Object(question)
            })
            .collect();
        let widgets: Vec<Json> =
            questions.iter().map(|question| json!({ "reference": question["response_id"] })).collect();
        let mut record = Object::new();
        record.insert("reference".into(), json!(format!("graffiticode-{id}-{index}")));
        record.insert("definition".into(), json!({ "widgets": widgets }));
        if let Some(dynamic) = &dynamic {
            record.insert("dynamic_content_data".into(), dynamic.clone());
        }
        record.insert("questions".into(), Json::Array(widgets));
        item_metadata(item.get("metadata"), &mut record);
        records.push((record, questions));
    }

    // An item only references its questions, so they must be in the bank first. The bank keys
    // a question by `reference`; `response_id` is the render envelope's name for it.
    let question_records: Vec<Json> = records
        .iter()
        .flat_map(|(_, questions)| questions)
        .map(|question| {
            let mut data = question.as_object().cloned().unwrap_or_default();
            let reference = data.remove("response_id").unwrap_or(Json::Null);
            json!({ "type": data.get("type").cloned().unwrap_or(Json::Null), "reference": reference, "data": data })
        })
        .collect();
    // Saved items always land as drafts; publishing is an Author Site concern.
    let item_records: Vec<Json> = records
        .iter()
        .map(|(record, _)| {
            let mut record = record.clone();
            record.insert("status".into(), json!("unpublished"));
            Json::Object(record)
        })
        .collect();

    let inline: Vec<Json> = records.into_iter().flat_map(|(_, questions)| questions).collect();
    let mut data = Object::new();
    data.insert("id".into(), json!(id));
    data.insert("name".into(), json!("Test"));
    data.insert("questions".into(), Json::Array(inline));
    if let Some(dynamic) = dynamic {
        data.insert("dynamic_content_data".into(), dynamic);
    }
    let mut activity = Object::new();
    activity.insert("type".into(), json!("questions"));
    activity.insert("data".into(), Json::Object(data));
    Ok(Built { activity, save_plan: json!({ "questionRecords": question_records, "itemRecords": item_records }) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_variables_are_marked_but_a_blank_is_not() {
        assert_eq!(variable_refs("{{x}} and {{response}} and {{{y}}}"), "{{var:x}} and {{response}} and {{var:{y}}}");
    }

    #[test]
    fn dynamic_content_keys_are_the_tables_own_and_keep_every_row_in_order() {
        let rows = json!([{ "v": "A" }, { "v": "A" }, { "v": "B" }]);
        let first = dynamic_content(Some(&rows)).unwrap().unwrap();
        // The same table gives the same keys on every run: a retried save sends the same payload.
        assert_eq!(dynamic_content(Some(&rows)).unwrap().unwrap(), first);
        // Duplicates aren't merged, and the order is kept: the View samples over row ids.
        let keys: Vec<_> = first["rows"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys.len(), 3);
        assert!(keys.iter().enumerate().all(|(i, key)| key.ends_with(&format!("-row-{i}"))), "{keys:?}");
        assert_eq!(first["rows"][&keys[0]]["values"], json!(["A"]));
        assert_eq!(first["rows"][&keys[1]]["values"], json!(["A"]));
        // Another table, other keys.
        let other = dynamic_content(Some(&json!([{ "v": "C" }]))).unwrap().unwrap();
        assert_ne!(other["rows"].as_object().unwrap().keys().next(), first["rows"].as_object().unwrap().keys().next());
    }
}
