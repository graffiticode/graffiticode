// SPDX-License-Identifier: MIT

//! The args digest that binds an execution token to one request. It MUST match the broker's
//! computation byte for byte (graffiticode `packages/broker/src/canonical.js`): SHA-256 over
//! canonical JSON — object keys sorted, no whitespace, numbers and strings as ECMAScript's
//! `JSON.stringify` writes them. The shared vectors below pin both sides.

use serde_json::Value as Json;
use sha2::{Digest, Sha256};

use crate::value::format_number;

pub fn canonical_json(value: &Json) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

pub fn args_digest(value: &Json) -> String {
    hex::encode(Sha256::digest(canonical_json(value)))
}

fn write(value: &Json, out: &mut String) {
    match value {
        Json::Number(n) => match n.as_f64() {
            Some(f) if !n.is_i64() && !n.is_u64() => out.push_str(&format_number(f)),
            _ => out.push_str(&n.to_string()),
        },
        Json::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Json::Object(object) => {
            // `JSON.stringify` order is UTF-16 code unit order, which differs from byte order
            // for keys beyond the Basic Multilingual Plane.
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Json::String(key.clone()).to_string());
                out.push(':');
                write(&object[key], out);
            }
            out.push('}');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // packages/common's CANONICAL_VECTORS, every one (scripts/test/canonical-vectors.test.js
    // checks this copy against it). If either side changes, an execution token minted by one
    // would never match the payload the other sees.
    #[test]
    fn matches_the_broker() {
        let vectors = [
            (
                json!({ "b": 2, "a": 1 }),
                r#"{"a":1,"b":2}"#,
                "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
            ),
            (
                json!({ "questions": [{ "response_id": "q-0", "type": "mcq", "stimulus": "Q é \"x\"" }], "id": "t" }),
                r#"{"id":"t","questions":[{"response_id":"q-0","stimulus":"Q é \"x\"","type":"mcq"}]}"#,
                "d5e95bc25861c09b8ddb35843b33f3d27aeef4f5a3853d8133c21897a9143e4b",
            ),
            (
                json!([1, "two", null, null, { "z": [true, false], "y": 1.5 }]),
                r#"[1,"two",null,null,{"y":1.5,"z":[true,false]}]"#,
                "2f51203a604c465370f084c3f413c5ce3f11bd736f1507cb2a6b96b1d46e632d",
            ),
            (json!("plain"), r#""plain""#, "945603a8f587786b463c3f94fce115c0fae88fac2728cc96ddf5981cf7f61741"),
            // An artifact's content: a compile envelope.
            (
                json!({ "data": { "type": "questions", "data": { "itemBank": { "saved": true, "references": ["graffiticode-t-0"] } } }, "errors": [] }),
                r#"{"data":{"data":{"itemBank":{"references":["graffiticode-t-0"],"saved":true}},"type":"questions"},"errors":[]}"#,
                "d5878057449f4231395e16ce6dfa6837b785cef4eeaeaffec47f87f18c401fd9",
            ),
            // Edges: an empty key, U+2028 kept literal, -0 as 0, exponent form.
            (
                json!({ "": { "\u{2028}": [{}, [], 0, -0.0, 1e21] } }),
                "{\"\":{\"\u{2028}\":[{},[],0,0,1e+21]}}",
                "1a91f0a4878b55e1f0f238c8ac4f15a3a9918674077ad0b2b2bb3947f442e4a2",
            ),
        ];
        for (value, canonical, digest) in vectors {
            assert_eq!(canonical_json(&value), canonical);
            assert_eq!(args_digest(&value), digest);
        }
    }

    #[test]
    fn numbers_are_written_as_ecmascript_writes_them() {
        assert_eq!(canonical_json(&json!([1.0, 1e21, 0.1, -3])), "[1,1e+21,0.1,-3]");
    }
}
