// SPDX-License-Identifier: MIT

//! The JSON Schema of a compiled L0187 board (`generated/schema.json`): the positioned board the
//! plugin draws and the preview renders. Every compiled board is tested against it.

use serde_json::{Value as Json, json};

use crate::vocab::{CAPS, NAMED_COLORS, SHAPE_KINDS};

/// The schema, as JSON.
pub fn schema() -> Json {
    let number = json!({ "type": "number" });
    let whole = json!({ "type": "number", "multipleOf": 1 });
    let rect = json!({
        "type": "object",
        "required": ["x", "y", "w", "h"],
        "properties": { "x": number, "y": number, "w": number, "h": number },
        "additionalProperties": false
    });
    let point = json!({
        "type": "object",
        "required": ["x", "y"],
        "properties": { "x": number, "y": number },
        "additionalProperties": false
    });
    let colour = json!({
        "type": "string",
        "anyOf": [{ "pattern": "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$" }, { "enum": NAMED_COLORS }]
    });
    let line = json!({
        "type": "object",
        "required": ["text", "break"],
        "properties": {
            "text": { "type": "string" },
            "break": {
                "type": "object",
                "required": ["kind"],
                "properties": {
                    "kind": { "enum": ["hard", "soft", "cluster", "end"] },
                    "text": { "type": "string" }
                },
                "additionalProperties": false
            }
        },
        "additionalProperties": false
    });
    let opacity = json!({ "type": "number", "minimum": 0, "maximum": 100 });
    let mark_common = json!({
        "id": { "type": "string" },
        "x": whole, "y": whole, "width": whole, "height": whole,
        "opacity": opacity,
        "text": { "type": "string" },
        "fontSize": { "enum": [16, 24, 40, 64, 96] },
        "lineHeight": number,
        "lines": { "type": "array", "items": { "$ref": "#/$defs/line" }, "minItems": 1 },
        "content": { "$ref": "#/$defs/rect" }
    });
    let with = |extra: Json, kind: &str, required: &[&str]| {
        let mut props = mark_common.as_object().cloned().expect("an object");
        props.insert("type".to_owned(), json!({ "const": kind }));
        for (k, v) in extra.as_object().cloned().expect("an object") {
            props.insert(k, v);
        }
        let mut req: Vec<&str> = vec![
            "type",
            "id",
            "x",
            "y",
            "width",
            "height",
            "opacity",
            "text",
            "fontSize",
            "lineHeight",
            "lines",
            "content",
        ];
        req.extend_from_slice(required);
        json!({ "type": "object", "required": req, "properties": props, "additionalProperties": false })
    };
    let sticky =
        with(json!({ "wide": { "type": "boolean" }, "fill": { "$ref": "#/$defs/colour" } }), "sticky", &["wide"]);
    let shape = with(
        json!({
            "shapeType": { "enum": SHAPE_KINDS.names().collect::<Vec<_>>() },
            "strokeWidth": { "enum": [4, 8] },
            "fill": { "$ref": "#/$defs/colour" },
            "stroke": { "$ref": "#/$defs/colour" }
        }),
        "shape",
        &["shapeType", "strokeWidth"],
    );
    let text = with(json!({ "color": { "$ref": "#/$defs/colour" } }), "text", &[]);
    let section = json!({
        "type": "object",
        "required": ["type", "id", "name", "opacity", "x", "y", "width", "height", "titleFrame", "nodes"],
        "properties": {
            "type": { "const": "section" },
            "id": { "type": "string" },
            "name": { "type": "string" },
            "fill": { "$ref": "#/$defs/colour" },
            "opacity": opacity,
            "x": whole, "y": whole, "width": whole, "height": whole,
            "titleFrame": { "$ref": "#/$defs/rect" },
            "nodes": { "type": "array", "items": { "anyOf": [
                { "$ref": "#/$defs/sticky" }, { "$ref": "#/$defs/shape" }, { "$ref": "#/$defs/text" }
            ] } }
        },
        "additionalProperties": false
    });
    let caps: Vec<&str> = CAPS.names().collect();
    let connector = json!({
        "type": "object",
        "required": ["type", "id", "from", "to", "lineType", "fromSide", "toSide", "waypoints", "fromCap", "toCap",
                     "strokeWidth", "opacity", "fontSize", "route", "labelLeg", "routeKind"],
        "properties": {
            "type": { "const": "connector" },
            "id": { "type": "string" },
            "from": { "type": "string" },
            "to": { "type": "string" },
            "lineType": { "const": "straight" },
            "fromSide": { "enum": ["TOP", "RIGHT", "BOTTOM", "LEFT"] },
            "toSide": { "enum": ["TOP", "RIGHT", "BOTTOM", "LEFT"] },
            "waypoints": { "type": "array", "items": { "$ref": "#/$defs/point" } },
            "fromCap": { "enum": caps },
            "toCap": { "enum": caps },
            "lineStyle": { "const": "dashed" },
            "stroke": { "$ref": "#/$defs/colour" },
            "strokeWidth": { "enum": [4, 8] },
            "opacity": opacity,
            "fontSize": { "enum": [16, 24, 40, 64, 96] },
            "label": { "type": "string" },
            "labelLines": { "type": "array", "items": { "$ref": "#/$defs/line" } },
            "route": { "type": "array", "items": { "$ref": "#/$defs/point" }, "minItems": 2 },
            "labelLeg": { "type": "integer", "minimum": 0 },
            "labelBox": { "$ref": "#/$defs/rect" },
            "routeKind": { "enum": ["straight", "elbow", "channel", "arc", "loop", "search"] }
        },
        "additionalProperties": false
    });
    let page = json!({
        "type": "object",
        "required": ["id", "name", "width", "height", "nodes", "groups"],
        "properties": {
            "id": { "type": "string" },
            "name": { "type": "string" },
            "background": { "$ref": "#/$defs/colour" },
            "width": whole,
            "height": whole,
            "nodes": { "type": "array", "items": { "anyOf": [
                { "$ref": "#/$defs/sticky" }, { "$ref": "#/$defs/shape" }, { "$ref": "#/$defs/text" },
                { "$ref": "#/$defs/section" }, { "$ref": "#/$defs/connector" }
            ] } },
            "groups": { "type": "array", "items": {
                "type": "object",
                "required": ["id", "frame", "members"],
                "properties": {
                    "id": { "type": "string" },
                    "frame": { "$ref": "#/$defs/rect" },
                    "members": { "type": "array", "items": { "type": "string" } }
                },
                "additionalProperties": false
            } }
        },
        "additionalProperties": false
    });
    let check = json!({
        "type": "object",
        "required": ["name", "scope", "required", "status"],
        "properties": {
            "name": { "type": "string" },
            "scope": { "enum": ["modeled", "native-unverified"] },
            "required": { "type": "boolean" },
            "status": { "enum": ["pass", "fail", "unverified"] },
            "failures": { "type": "array", "items": { "type": "string" } }
        },
        "additionalProperties": false
    });
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://l0187.graffiticode.org/schema.json",
        "title": "L0187 positioned FigJam board",
        "description": "The board an L0187 program compiles to: every mark, section and connector positioned by the compiler under its layout profile, with the independent validator's report.",
        "type": "object",
        "required": ["type", "positioned", "profile", "revision", "showPageTabs", "showPageMenu", "pages", "report"],
        "properties": {
            "type": { "const": "board" },
            "positioned": { "const": 1 },
            "profile": { "const": "FIGJAM_V1" },
            "revision": {
                "type": "object",
                "required": ["compiler", "font", "layout"],
                "properties": { "compiler": { "type": "string" }, "font": { "type": "string" }, "layout": { "type": "string" } },
                "additionalProperties": false
            },
            "title": { "type": "string" },
            "showPageTabs": { "type": "boolean" },
            "showPageMenu": { "type": "boolean" },
            "fileKey": { "type": "string" },
            "pages": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/page" } },
            "report": {
                "type": "object",
                "required": ["accepted", "checks", "quality", "repair"],
                "properties": {
                    "accepted": { "const": true },
                    "checks": { "type": "array", "items": { "$ref": "#/$defs/check" } },
                    "quality": {
                        "type": "object",
                        "required": ["crossings", "bends", "route_length"],
                        "properties": { "crossings": { "type": "integer" }, "bends": { "type": "integer" }, "route_length": number },
                        "additionalProperties": false
                    },
                    "repair": {
                        "type": "object",
                        "required": ["rounds", "evaluations"],
                        "properties": { "rounds": { "type": "integer" }, "evaluations": { "type": "integer" } },
                        "additionalProperties": false
                    }
                },
                "additionalProperties": false
            }
        },
        "additionalProperties": false,
        "$defs": {
            "rect": rect, "point": point, "colour": colour, "line": line,
            "sticky": sticky, "shape": shape, "text": text, "section": section, "connector": connector,
            "page": page, "check": check
        }
    })
}

/// The schema as the JSON document `generated/schema.json` holds.
pub fn schema_json() -> String {
    serde_json::to_string_pretty(&schema()).expect("the schema serializes") + "\n"
}
