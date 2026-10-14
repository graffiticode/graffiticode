// SPDX-License-Identifier: MIT

//! Rating scales (`scales.ts`): the presets a survey can name, and how any scale a survey
//! writes is checked and normalised to ONE shape — an ordered list of points, each a value and,
//! where it has one, a label. A preset, a list of labelled points and a numeric range with its
//! ends anchored all come out the same.

use crate::attributes::VOCAB;
use crate::js::{Js, Obj, is_integer, is_text, normalise_text, num, quote, show_value, trim};

/// Fewest and most points a scale may have. Two is a yes/no; eleven is 0–10.
const MIN_POINTS: usize = 2;
const MAX_POINTS: usize = 11;

#[derive(Clone, Debug, PartialEq)]
pub struct Point {
    pub value: f64,
    pub label: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Scale {
    /// The preset or `scales` entry this came from, when it had a name.
    pub name: Option<String>,
    pub points: Vec<Point>,
    /// An answer outside the scale ("Not applicable"), recorded as an opt-out.
    pub opt_out: Option<String>,
    /// A rendering hint only.
    pub display: Option<String>,
    /// The order the fields were first set in. The TypeScript builds the record by spreading
    /// and then assigning, so a field set later (`optOut`, `display`, a `scales` name over a
    /// nested preset) follows the ones already there, and the output keeps that order.
    order: Vec<&'static str>,
}

impl Scale {
    fn new(name: Option<&str>, points: Vec<Point>) -> Scale {
        let mut scale = Scale { name: None, points, opt_out: None, display: None, order: Vec::new() };
        if let Some(name) = name {
            scale.set_name(name);
        }
        scale.order.push("points");
        scale
    }

    fn touch(&mut self, key: &'static str) {
        if !self.order.contains(&key) {
            self.order.push(key);
        }
    }

    fn set_name(&mut self, name: &str) {
        self.name = Some(name.to_owned());
        self.touch("name");
    }

    fn set_opt_out(&mut self, opt_out: &str) {
        self.opt_out = Some(opt_out.to_owned());
        self.touch("optOut");
    }

    fn set_display(&mut self, display: &str) {
        self.display = Some(display.to_owned());
        self.touch("display");
    }

    pub fn to_js(&self) -> Js {
        let mut obj = Obj::new();
        for key in &self.order {
            let value = match *key {
                "name" => self.name.clone().map(Js::Str),
                "optOut" => self.opt_out.clone().map(Js::Str),
                "display" => self.display.clone().map(Js::Str),
                _ => Some(Js::List(
                    self.points
                        .iter()
                        .map(|p| {
                            let mut point = Obj::from([("value".to_owned(), Js::Num(p.value))]);
                            if let Some(label) = &p.label {
                                point.insert("label".into(), Js::Str(label.clone()));
                            }
                            Js::Obj(point)
                        })
                        .collect(),
                )),
            };
            if let Some(value) = value {
                obj.insert((*key).to_owned(), value);
            }
        }
        Js::Obj(obj)
    }
}

fn range(min: f64, max: f64, low: Option<&str>, high: Option<&str>) -> Vec<Point> {
    let mut points = Vec::new();
    let mut v = min;
    while v <= max {
        points.push(Point { value: v, label: None });
        v += 1.0;
    }
    if let (Some(low), Some(first)) = (low.filter(|l| !l.is_empty()), points.first_mut()) {
        first.label = Some(low.to_owned());
    }
    if let (Some(high), Some(last)) = (high.filter(|h| !h.is_empty()), points.last_mut()) {
        last.label = Some(high.to_owned());
    }
    points
}

/// A preset by name, copied. The table is generated from `PRESETS` in `scales.ts`, where each
/// preset is points (labelled or a bare range) and, for stars, a display hint.
fn from_preset(name: &str) -> Option<Scale> {
    let preset = VOCAB.presets.get(name)?;
    let points = preset["points"]
        .as_array()?
        .iter()
        .map(|p| Point {
            value: p["value"].as_f64().unwrap_or(f64::NAN),
            label: p["label"].as_str().map(str::to_owned),
        })
        .collect();
    let mut scale = Scale::new(Some(name), points);
    if let Some(display) = preset["display"].as_str().filter(|d| !d.is_empty()) {
        scale.set_display(display);
    }
    Some(scale)
}

/// Checks a scale's points once it is built: count, rising whole values, labels that can be
/// told apart, and an opt-out that is not also a point.
fn assert_points(place: &str, scale: &Scale) -> Result<(), String> {
    let points = &scale.points;
    if points.len() < MIN_POINTS || points.len() > MAX_POINTS {
        return Err(format!("{place} has {} points; a scale has {MIN_POINTS} to {MAX_POINTS}.", points.len()));
    }
    for (i, p) in points.iter().enumerate() {
        if !is_integer(p.value) {
            return Err(format!(
                "{place}, point {} has the value {}; values are whole numbers.",
                i + 1,
                show_value(&Js::Num(p.value))
            ));
        }
        if i > 0 && p.value <= points[i - 1].value {
            return Err(format!(
                "{place} has the value {} after {}; a scale's values must rise from its first point to its last.",
                num(p.value),
                num(points[i - 1].value)
            ));
        }
    }
    let mut seen: Vec<(String, usize)> = Vec::new();
    for (i, p) in points.iter().enumerate() {
        let Some(label) = &p.label else { continue };
        let key = normalise_text(label);
        if let Some((_, at)) = seen.iter().find(|(k, _)| *k == key) {
            return Err(format!(
                "{place} labels points {} and {} both {}, so an answer naming it is ambiguous.",
                at + 1,
                i + 1,
                quote(label)
            ));
        }
        seen.push((key, i));
    }
    if let Some(opt_out) = &scale.opt_out
        && seen.iter().any(|(k, _)| *k == normalise_text(opt_out))
    {
        return Err(format!(
            "{place} has an `optOut` of {}, which is also the label of one of its points. An opt-out is an answer outside the scale; give it its own words.",
            quote(opt_out)
        ));
    }
    Ok(())
}

/// Reads one scale as a survey writes it: a preset name, or a record that is exactly one of
/// `{preset}`, `{points}`, `{min, max, anchors?}`, any of which may add `optOut` and
/// `display`. `name` is what the scale is called under `scales`, when it is called anything.
pub fn read_scale(place: &str, raw: &Js, name: Option<&str>) -> Result<Scale, String> {
    let name = name.filter(|n| !n.is_empty());
    if let Js::Str(preset) = raw {
        return from_preset(preset).ok_or_else(|| {
            let names: Vec<&str> = VOCAB.presets.keys().map(String::as_str).collect();
            format!(
                "{place} names the scale {}, which is not a preset. The presets are: {} — or define it under `scales`.",
                quote(preset),
                names.join(", ")
            )
        });
    }
    if !matches!(raw, Js::Obj(_)) {
        return Err(format!(
            "{place} is {}. A scale is a preset name, or a record with `preset`, `points`, or `min` and `max`.",
            show_value(raw)
        ));
    }

    let forms: Vec<&str> = ["preset", "points", "min"].into_iter().filter(|k| !raw.get(k).is_undefined()).collect();
    if forms.len() != 1 {
        let said = if forms.is_empty() {
            "says nothing about its points".to_owned()
        } else {
            format!("mixes {}", forms.iter().map(|f| format!("`{f}`")).collect::<Vec<_>>().join(" and "))
        };
        return Err(format!("{place} {said}. Give exactly one of `preset`, `points`, or `min` and `max`."));
    }

    let mut scale = if !raw.get("preset").is_undefined() {
        let mut scale = read_scale(place, raw.get("preset"), None)?;
        if let Some(name) = name {
            scale.set_name(name);
        }
        scale
    } else if !raw.get("points").is_undefined() {
        let Js::List(given) = raw.get("points") else {
            return Err(format!("{place} has `points` that are {}; they are a list.", show_value(raw.get("points"))));
        };
        let mut points = Vec::new();
        for (i, p) in given.iter().enumerate() {
            if let Js::Str(label) = p
                && is_text(p)
            {
                points.push(Point { value: (i + 1) as f64, label: Some(trim(label).to_owned()) });
                continue;
            }
            if let (Js::Obj(_), Js::Num(value)) = (p, p.get("value")) {
                let label = p.get("label");
                if !label.is_undefined() && !is_text(label) {
                    return Err(format!("{place}, point {} has a `label` that is {}.", i + 1, show_value(label)));
                }
                points.push(Point { value: *value, label: label.as_str().map(|l| trim(l).to_owned()) });
                continue;
            }
            return Err(format!(
                "{place}, point {} is {}. A point is a label, or a record with a numeric `value` and an optional `label`.",
                i + 1,
                show_value(p)
            ));
        }
        Scale::new(name, points)
    } else {
        let (min, max) = (raw.get("min"), raw.get("max"));
        let (Js::Num(lo), Js::Num(hi)) = (min, max) else {
            return Err(whole_number_ends(place, min, max));
        };
        let (lo, hi) = (*lo, *hi);
        if !is_integer(lo) || !is_integer(hi) {
            return Err(whole_number_ends(place, min, max));
        }
        if hi <= lo {
            return Err(format!("{place} runs from {} to {}; `max` must be above `min`.", num(lo), num(hi)));
        }
        let count = hi - lo + 1.0;
        if count > MAX_POINTS as f64 {
            return Err(format!(
                "{place} runs from {} to {}, which is {} points; a scale has at most {MAX_POINTS}.",
                num(lo),
                num(hi),
                num(count)
            ));
        }
        let ends = read_anchors(place, raw.get("anchors"))?;
        let points = range(lo, hi, ends.as_ref().map(|e| e.0.as_str()), ends.as_ref().map(|e| e.1.as_str()));
        Scale::new(name, points)
    };

    let opt_out = raw.get("optOut");
    if !opt_out.is_undefined() {
        if !is_text(opt_out) {
            return Err(format!(
                "{place} has an `optOut` that is {}; it is the words for the answer outside the scale.",
                show_value(opt_out)
            ));
        }
        scale.set_opt_out(trim(opt_out.as_str().unwrap_or_default()));
    }
    let display = raw.get("display");
    if !display.is_undefined() {
        if display.as_str() != Some("stars") {
            return Err(format!("{place} has a `display` of {}; the only one is \"stars\".", show_value(display)));
        }
        scale.set_display("stars");
    }
    assert_points(place, &scale)?;
    Ok(scale)
}

fn whole_number_ends(place: &str, min: &Js, max: &Js) -> String {
    format!("{place} needs whole-number `min` and `max`; got {} and {}.", show_value(min), show_value(max))
}

/// Words for the two ends of a scale — a numeric range's, or an item's own on a shared scale (a
/// semantic differential).
pub fn read_anchors(place: &str, raw: &Js) -> Result<Option<(String, String)>, String> {
    if raw.is_undefined() {
        return Ok(None);
    }
    let pair = match raw {
        Js::List(items) if items.len() == 2 && items.iter().all(is_text) => items,
        _ => {
            return Err(format!(
                "{place} has `anchors` that are {}. Anchors are two words, the low end then the high: [\"difficult\", \"easy\"].",
                show_value(raw)
            ));
        }
    };
    let (low, high) = (pair[0].as_str().unwrap_or_default(), pair[1].as_str().unwrap_or_default());
    if normalise_text(low) == normalise_text(high) {
        return Err(format!("{place} anchors both ends {}; the two ends must differ.", quote(low)));
    }
    Ok(Some((trim(low).to_owned(), trim(high).to_owned())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scale(json: serde_json::Value) -> Result<Scale, String> {
        read_scale("s", &Js::from_json(&json), None)
    }

    #[test]
    fn presets_load_as_their_points() {
        let nps = scale(json!("nps")).unwrap();
        assert_eq!(nps.points.len(), 11);
        assert_eq!(nps.points[0], Point { value: 0.0, label: Some("Not at all likely".into()) });
        assert_eq!(nps.points[5].label, None);
        let stars = scale(json!("stars-5")).unwrap();
        assert_eq!(stars.display.as_deref(), Some("stars"));
        assert_eq!(scale(json!("agreement-7")).unwrap().points[6].label.as_deref(), Some("Strongly agree"));
    }

    #[test]
    fn keys_keep_the_order_they_were_set_in() {
        let order = |json| {
            let Js::Obj(obj) = scale(json).unwrap().to_js() else { panic!() };
            obj.keys().cloned().collect::<Vec<_>>()
        };
        assert_eq!(order(json!({ "preset": "stars-5", "optOut": "Skip" })), ["name", "points", "display", "optOut"]);
        assert_eq!(
            order(json!({ "points": ["a", "b"], "display": "stars", "optOut": "Skip" })),
            ["points", "optOut", "display"]
        );
        assert_eq!(order(json!({ "points": ["a", "b"], "display": "stars" })), ["points", "display"]);
    }

    #[test]
    fn a_range_labels_only_its_ends() {
        let s = scale(json!({ "min": -2, "max": 2, "anchors": [" low ", "high"] })).unwrap();
        let labels: Vec<_> = s.points.iter().map(|p| p.label.clone()).collect();
        assert_eq!(labels, [Some("low".into()), None, None, None, Some("high".into())]);
        assert!(scale(json!({ "min": 0, "max": 11 })).unwrap_err().contains("12 points"));
    }
}
