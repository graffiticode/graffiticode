// SPDX-License-Identifier: MIT

//! JavaScript's reading of a JSON object.

use serde_json::Value as Json;

/// Orders every object's keys as a JavaScript object enumerates them: array-index keys first,
/// ascending, then the rest in insertion order. That is the order `JSON.stringify` writes, so
/// it is the order of the TypeScript compiler's output.
pub fn order(json: Json) -> Json {
    match json {
        Json::Object(object) => {
            let (mut indices, named): (Vec<_>, Vec<_>) =
                object.into_iter().map(|(key, value)| (key, order(value))).partition(|(key, _)| index(key).is_some());
            indices.sort_by_key(|(key, _)| index(key));
            Json::Object(indices.into_iter().chain(named).collect())
        }
        Json::Array(items) => Json::Array(items.into_iter().map(order).collect()),
        other => other,
    }
}

/// A key JavaScript treats as an array index.
fn index(key: &str) -> Option<u32> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_take_javascripts_order() {
        let ordered = order(json!({ "b": 1, "10": 2, "a": { "2": 0, "z": 1, "1": 2 }, "01": 3, "2": 4 }));
        assert_eq!(ordered.to_string(), r#"{"2":4,"10":2,"b":1,"a":{"1":2,"2":0,"z":1},"01":3}"#);
    }
}
