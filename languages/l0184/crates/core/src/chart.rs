// SPDX-License-Identifier: MIT

//! One chart: its parts resolved, checked and lowered to an ECharts option
//! (`packages/core/src/chart.ts`).
//!
//! Order matters and is fixed, because the first problem found is the one reported: datasets
//! are selected, every column reference is resolved, the plots' family is settled, axes are
//! normalized and plots bound to them by id, and only then are data shapes checked.
//!
//! Families decide what may share a chart. Cartesian plots (BAR, LINE, SCATTER, BOXPLOT,
//! CANDLESTICK) share X and Y axes; HISTOGRAM, HEATMAP, FUNNEL and PIE each take a chart of their
//! own; GAUGEs sit side by side, one to four; RADAR plots share one RADIAL axis.

use std::collections::HashMap;

use crate::colors::{resolve_color, resolve_colors};
use crate::data::{Resolved, Scope, Selection, Shape, resolve_data, same_value_zero, scope_datasets, select_dataset};
use crate::date;
use crate::js::{Js, Obj, js_string, keys, num, strict_eq, stringify};
use crate::obj;
use crate::stats::{Bins, boxplot, constant_range, histogram, nice_ceil};
use crate::vocab::{VOCAB, assert_known_attributes, source_word};

type R<T> = Result<T, String>;

/// `JSON.stringify`, as the TypeScript's `q` quotes names in messages.
fn q(v: &Js) -> String {
    stringify(v)
}

fn qs(s: &str) -> String {
    stringify(&Js::str(s))
}

fn plural(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

fn list_of(xs: &[String]) -> String {
    match xs {
        [] => "undefined".to_owned(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// A tag-valued field as written (`"BAR"`), as the string the TypeScript compares.
fn text(v: &Js) -> String {
    js_string(v)
}

/// `TypeError` for `undefined.includes(…)`, which the TypeScript meets on a kind it has no row
/// for (only reachable through a record that sets `kind` directly).
fn no_row() -> String {
    "Cannot read properties of undefined (reading 'includes')".to_owned()
}

/* ------------------------------------------------------------------ values */

fn numbers(values: &[Js], prop: &str, place: &str, nulls: bool) -> R<Vec<Js>> {
    for (i, v) in values.iter().enumerate() {
        match v {
            Js::Null if nulls => {}
            Js::Null => {
                return Err(format!(
                    "{place}: {prop} item {} is null. A missing value is only allowed where the plot can show a gap.",
                    i + 1
                ));
            }
            Js::Num(_) => {}
            other => return Err(format!("{place}: {prop} item {} is {}, not a number.", i + 1, qs(&js_string(other)))),
        }
    }
    Ok(values.to_vec())
}

fn floats(values: &[Js]) -> Vec<f64> {
    values.iter().map(|v| v.as_num().unwrap_or(f64::NAN)).collect()
}

fn labels(values: &[Js], prop: &str, place: &str) -> R<Vec<String>> {
    values
        .iter()
        .enumerate()
        .map(|(i, v)| match v {
            Js::Null | Js::Bool(_) => Err(format!(
                "{place}: {prop} item {} must be a name in \"quotes\" or a number, got {}.",
                i + 1,
                js_string(v)
            )),
            other => Ok(js_string(other)),
        })
        .collect()
}

fn time_values(values: &[Js], prop: &str, place: &str) -> R<Vec<Js>> {
    for (i, v) in values.iter().enumerate() {
        let ok = match v {
            Js::Num(n) => n.is_finite(),
            Js::Str(s) => date::parses(s),
            _ => false,
        };
        if !ok {
            let shown = if matches!(v, Js::Null) { "null".to_owned() } else { qs(&js_string(v)) };
            return Err(format!(
                "{place}: {prop} item {} is {shown}, not a date (e.g. \"2026-03-01\") or a millisecond timestamp.",
                i + 1
            ));
        }
    }
    Ok(values.to_vec())
}

fn positive_on_log(values: &[Js], prop: &str, axis: &Axis, place: &str) -> R<()> {
    for (i, v) in values.iter().enumerate() {
        if let Js::Num(n) = v
            && !(*n > 0.0)
        {
            return Err(format!(
                "{place}: {prop} item {} is {}, but axis {} is LOG, which only shows values above 0.",
                i + 1,
                num(*n),
                q(&axis.id)
            ));
        }
    }
    Ok(())
}

fn same_length(place: &str, cols: &[(&str, usize)]) -> R<()> {
    let (a, an) = cols[0];
    for &(b, bn) in &cols[1..] {
        if an != bn {
            return Err(format!(
                "{place}: {a} has {an} items but {b} has {bn}. They pair up, so they must be the same length."
            ));
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------ axes */

#[derive(Clone, Debug)]
pub struct Axis {
    pub id: Js,
    pub direction: String,
    pub scale: String,
    pub categories: Option<Vec<String>>,
    pub name: Js,
    pub position: String,
    pub offset: f64,
    pub min_value: Js,
    pub max_value: Js,
    pub inverse: Js,
    pub rotate: Js,
    pub index: usize,
    pub place: String,
}

type Resolve<'a> = dyn Fn(&Js, &str, &str, Shape) -> R<Resolved> + 'a;

fn normalize_axes(recs: &[Js], place: &str, resolve: &Resolve<'_>, default_scale: &str) -> R<Vec<Axis>> {
    let mut count: HashMap<String, usize> = HashMap::new();
    let mut axes: Vec<Axis> = Vec::with_capacity(recs.len());
    for (i, rec) in recs.iter().enumerate() {
        let id = rec.prop("id")?;
        let w = format!("{place} axis {}", if id.truthy() { q(id) } else { (i + 1).to_string() });
        if !rec.get("direction").truthy() {
            return Err(format!("{w}: needs a direction, X, Y or RADIAL, e.g. axis direction X {{}}."));
        }
        let direction = text(rec.get("direction"));
        let radial = direction == "RADIAL";
        let n = {
            let c = count.entry(direction.clone()).or_insert(0);
            *c += 1;
            *c
        };
        let rec_scale = rec.get("scale");
        if radial && !rec_scale.is_undefined() && text(rec_scale) != "CATEGORY" {
            return Err(format!(
                "{w}: a RADIAL axis is CATEGORY — its categories are the spokes — not {}.",
                text(rec_scale)
            ));
        }
        let scale = if radial {
            "CATEGORY".to_owned()
        } else if !rec_scale.is_nullish() {
            text(rec_scale)
        } else if !rec.get("categories").is_undefined() {
            "CATEGORY".to_owned()
        } else {
            default_scale.to_owned()
        };
        let mut axis = Axis {
            id: id.or(Js::Str(format!("{}{n}", direction.to_lowercase()))),
            direction: direction.clone(),
            scale: scale.clone(),
            categories: None,
            name: rec.get("name").clone(),
            position: String::new(),
            offset: 0.0,
            min_value: Js::Undefined,
            max_value: Js::Undefined,
            inverse: rec.get("inverse").clone(),
            rotate: rec.get("rotate").clone(),
            index: n - 1,
            place: w.clone(),
        };
        if !rec.get("categories").is_undefined() {
            if scale != "CATEGORY" {
                return Err(format!("{w}: categories belong on a CATEGORY axis; this axis is {scale}."));
            }
            let cats =
                labels(&resolve(rec.get("categories"), "categories", &w, Shape::Flat)?.values, "categories", &w)?;
            if let Some(dup) = cats.iter().enumerate().find(|(j, c)| cats[..*j].contains(c)).map(|(_, c)| c) {
                let (what, whats) = if radial { ("spoke", "Spokes") } else { ("category", "Categories") };
                return Err(format!("{w}: the {what} {} appears twice. {whats} must differ.", qs(dup)));
            }
            axis.categories = Some(cats);
        }
        for field in ["minValue", "maxValue"] {
            let v = rec.get(field);
            if v.is_undefined() {
                continue;
            }
            let word = source_word(field);
            if radial {
                if !matches!(v, Js::Num(_)) {
                    return Err(format!("{w}: {word} must be a number on a RADIAL axis, got {}.", qs(&js_string(v))));
                }
            } else if scale == "CATEGORY" {
                return Err(format!("{w}: {word} does not apply to a CATEGORY axis."));
            } else if scale == "TIME" {
                if !(matches!(v, Js::Num(_)) || date::parses(&js_string(v))) {
                    return Err(format!("{w}: {word} {} is not a date.", qs(&js_string(v))));
                }
            } else if let Js::Num(n) = v {
                if scale == "LOG" && !(*n > 0.0) {
                    return Err(format!("{w}: {word} is {}, but a LOG axis only shows values above 0.", num(*n)));
                }
            } else {
                return Err(format!("{w}: {word} must be a number on a {scale} axis, got {}.", qs(&js_string(v))));
            }
            if field == "minValue" {
                axis.min_value = v.clone();
            } else {
                axis.max_value = v.clone();
            }
        }
        if let (Js::Num(min), Js::Num(max)) = (&axis.min_value, &axis.max_value)
            && min >= max
        {
            return Err(format!("{w}: min-value ({}) must be less than max-value ({}).", num(*min), num(*max)));
        }
        if radial {
            for word in ["position", "rotate"] {
                if !rec.get(word).is_undefined() {
                    return Err(format!(
                        "{w}: a RADIAL axis has no {word}; its spokes are spaced evenly around the circle."
                    ));
                }
            }
            let Some(cats) = &axis.categories else {
                return Err(format!(
                    "{w}: a RADIAL axis needs categories, one per spoke, e.g. categories [\"Speed\" \"Power\" \"Range\"]."
                ));
            };
            if cats.len() < 3 {
                return Err(format!(
                    "{w}: a RADIAL axis needs at least 3 spokes; it has {}. For fewer, use a BAR chart.",
                    cats.len()
                ));
            }
            axes.push(axis);
            continue;
        }
        if let Js::Num(r) = rec.get("rotate")
            && (*r < -90.0 || *r > 90.0)
        {
            return Err(format!("{w}: rotate must be between -90 and 90, got {}.", num(*r)));
        }
        let legal = if direction == "X" { ["BOTTOM", "TOP"] } else { ["LEFT", "RIGHT"] };
        let position = rec.get("position");
        if !position.is_undefined() && !position.as_str().is_some_and(|p| legal.contains(&p)) {
            return Err(format!(
                "{w}: an {direction} axis sits at {}, not {}.",
                legal.join(" or "),
                js_string(position)
            ));
        }
        axis.position =
            if position.is_nullish() { (if n == 1 { legal[0] } else { legal[1] }).to_owned() } else { text(position) };
        axes.push(axis);
    }
    for (i, a) in axes.iter().enumerate() {
        if axes[..i].iter().any(|b| same_value_zero(&b.id, &a.id)) {
            return Err(format!("{place}: two axes have the id {}. Give each axis its own id.", q(&a.id)));
        }
    }
    // Axes that share a side are pushed outward so they do not draw over each other.
    let offsets: Vec<f64> = axes
        .iter()
        .map(|a| {
            56.0 * axes
                .iter()
                .filter(|b| b.index < a.index && b.direction == a.direction && b.position == a.position)
                .count() as f64
        })
        .collect();
    for (a, offset) in axes.iter_mut().zip(offsets) {
        a.offset = offset;
    }
    Ok(axes)
}

fn bind_axis(reference: &Js, direction: &str, axes: &[Axis], place: &str) -> R<usize> {
    let word = if direction == "X" { "x-axis" } else { "y-axis" };
    let candidates: Vec<usize> = (0..axes.len()).filter(|&i| axes[i].direction == direction).collect();
    let named = || {
        let ids: Vec<String> = candidates.iter().map(|&i| q(&axes[i].id)).collect();
        if ids.is_empty() { "none".to_owned() } else { ids.join(", ") }
    };
    if !reference.is_undefined() {
        let Some(at) = axes.iter().position(|b| strict_eq(&b.id, reference)) else {
            return Err(format!("{place}: {word} {} names no axis. {direction} axes here: {}.", q(reference), named()));
        };
        if axes[at].direction != direction {
            return Err(format!("{place}: {word} {} is a {} axis, not {direction}.", q(reference), axes[at].direction));
        }
        return Ok(at);
    }
    match candidates.as_slice() {
        [one] => Ok(*one),
        [] => Err(format!(
            "{place}: there is no {direction} axis to draw against. Add axis direction {direction} … {{}} to the chart's axes."
        )),
        _ => Err(format!(
            "{place}: there are {} {direction} axes ({}), so write {word} \"…\" to pick one.",
            candidates.len(),
            named()
        )),
    }
}

/* ------------------------------------------------------------------ plots */

fn check_label(rec: &Js, kind: &str, place: &str) -> R<Option<Obj>> {
    if rec.is_undefined() {
        return Ok(None);
    }
    assert_known_attributes("label", rec, &format!("{place} label"), None)?;
    let position = rec.prop("position")?;
    if !position.is_undefined() {
        let Some(legal) = VOCAB.label_positions.get(kind) else { return Err(no_row()) };
        if !position.as_str().is_some_and(|p| legal.iter().any(|l| l == p)) {
            return Err(format!(
                "{place} label: a {kind} label sits at {}, not {}.",
                legal.join(", "),
                js_string(position)
            ));
        }
    }
    let mut label = obj! { "show" => rec.get("show").or(Js::Bool(true)) };
    if !position.is_undefined() {
        label.insert("position".into(), Js::Str(text(position).to_lowercase()));
    }
    if !rec.get("formatter").is_undefined() {
        label.insert("formatter".into(), rec.get("formatter").clone());
    }
    Ok(Some(label))
}

fn is_nested(v: &Js) -> bool {
    v.as_arr().is_some_and(|items| items.iter().any(|row| matches!(row, Js::Arr(_))))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Form {
    Category,
    Xy,
    Slices,
    Hist,
    Box,
    Candle,
    Heat,
    Gauge,
    Radar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    Cartesian,
    Single,
    Gauge,
    Radar,
}

fn family(kind: &str) -> Family {
    match kind {
        "HISTOGRAM" | "HEATMAP" | "FUNNEL" | "PIE" => Family::Single,
        "GAUGE" => Family::Gauge,
        "RADAR" => Family::Radar,
        _ => Family::Cartesian,
    }
}

const MAX_GAUGES: usize = 4;

struct Plot {
    id: Js,
    kind: String,
    name: Js,
    place: String,
    src: Js,
    form: Form,
    values: Option<Vec<Js>>,
    names: Option<Vec<String>>,
    x: Option<Vec<Js>>,
    y: Option<Vec<Js>>,
    /// A HEATMAP written as cells: each cell's X and Y category.
    cell_x: Option<Vec<String>>,
    cell_y: Option<Vec<String>>,
    x_axis: Option<usize>,
    y_axis: Option<usize>,
    base: Option<usize>,
    bins: Option<Bins>,
    observations: Option<Vec<f64>>,
    groups: Option<Vec<String>>,
    nested: Option<Vec<Vec<f64>>>,
    ohlc: Option<[Vec<f64>; 4]>,
    matrix: Option<Vec<Vec<Js>>>,
    cells: Option<Vec<[f64; 3]>>,
    gauge: Option<(f64, f64, f64)>,
}

fn normalize_plot(rec: &Js, i: usize, place: &str, resolve: &Resolve<'_>) -> R<Plot> {
    let id = rec.prop("id")?;
    let w = format!("{place} plot {}", if id.truthy() { q(id) } else { (i + 1).to_string() });
    if !rec.get("kind").truthy() {
        return Err(format!(
            "{w}: needs a kind, one of {}, e.g. plot kind BAR values [1 2 3] {{}}.",
            VOCAB.kinds.join(", ")
        ));
    }
    let kind = text(rec.get("kind"));
    let Some(allowed) = VOCAB.plot_kind_attributes.get(&kind) else { return Err(no_row()) };
    if let Some(stray) = keys(rec).into_iter().map(|k| source_word(&k)).find(|k| !allowed.contains(k)) {
        let kinds: Vec<&str> =
            VOCAB.plot_kind_attributes.iter().filter(|(_, ws)| ws.contains(&stray)).map(|(k, _)| k.as_str()).collect();
        let also =
            if kinds.is_empty() { String::new() } else { format!(" `{stray}` is for {} plots.", kinds.join(", ")) };
        return Err(format!(
            "{w}: `{stray}` does not apply to a {kind} plot. A {kind} plot takes: {}.{also}",
            allowed.join(", ")
        ));
    }
    let mut plot = Plot {
        id: id.or(Js::Str(format!("p{}", i + 1))),
        kind: kind.clone(),
        name: Js::Undefined,
        place: w.clone(),
        src: rec.clone(),
        form: Form::Category,
        values: None,
        names: None,
        x: None,
        y: None,
        cell_x: None,
        cell_y: None,
        x_axis: None,
        y_axis: None,
        base: None,
        bins: None,
        observations: None,
        groups: None,
        nested: None,
        ohlc: None,
        matrix: None,
        cells: None,
        gauge: None,
    };
    let field = |name: &str| rec.get(name);
    let need = |prop: &str| -> R<Resolved> {
        if field(prop).is_undefined() {
            return Err(format!("{w}: a {kind} plot needs {}.", source_word(prop)));
        }
        resolve(field(prop), &source_word(prop), &w, Shape::Flat)
    };
    let need_numbers = |prop: &str| -> R<Vec<f64>> { Ok(floats(&numbers(&need(prop)?.values, prop, &w, false)?)) };
    let mut column: Option<Js> = None;

    match kind.as_str() {
        "BAR" => {
            let r = need("values")?;
            column = r.column;
            plot.values = Some(numbers(&r.values, "values", &w, true)?);
        }
        "LINE" => {
            let xy = !field("x").is_undefined() || !field("y").is_undefined();
            if xy && !field("values").is_undefined() {
                return Err(format!(
                    "{w}: write a LINE either with values (one per category) or with x and y (pairs), not both."
                ));
            }
            if xy {
                if field("x").is_undefined() || field("y").is_undefined() {
                    return Err(format!("{w}: a LINE written with pairs needs both x and y."));
                }
                plot.form = Form::Xy;
                plot.x = Some(resolve(field("x"), "x", &w, Shape::Flat)?.values);
                let r = resolve(field("y"), "y", &w, Shape::Flat)?;
                column = r.column;
                plot.y = Some(numbers(&r.values, "y", &w, true)?);
            } else {
                let r = need("values")?;
                column = r.column;
                plot.values = Some(numbers(&r.values, "values", &w, true)?);
            }
            if field("smooth").truthy() && !field("step").is_undefined() {
                return Err(format!("{w}: a LINE is smooth or stepped, not both."));
            }
        }
        "SCATTER" => {
            plot.form = Form::Xy;
            plot.x = Some(need("x")?.values);
            let r = need("y")?;
            column = r.column;
            plot.y = Some(numbers(&r.values, "y", &w, true)?);
            if !field("names").is_undefined() {
                plot.names = Some(labels(&resolve(field("names"), "names", &w, Shape::Flat)?.values, "names", &w)?);
            }
        }
        "PIE" | "FUNNEL" => {
            plot.form = Form::Slices;
            plot.names = Some(labels(&need("names")?.values, "names", &w)?);
            let r = need("values")?;
            column = r.column;
            let values = numbers(&r.values, "values", &w, false)?;
            for (j, v) in values.iter().enumerate() {
                if let Js::Num(n) = v
                    && *n < 0.0
                {
                    let noun = if kind == "PIE" { "slice" } else { "stage" };
                    return Err(format!(
                        "{w}: values item {} is {}; a {kind} {noun} cannot be negative.",
                        j + 1,
                        num(*n)
                    ));
                }
            }
            plot.values = Some(values);
        }
        "HISTOGRAM" => {
            plot.form = Form::Hist;
            if is_nested(field("values")) {
                return Err(format!(
                    "{w}: a HISTOGRAM counts raw observations, so values is one flat list, e.g. values [3 7 7 9 12]. To draw counts you already have, use a BAR."
                ));
            }
            let r = need("values")?;
            column = r.column;
            let obs = floats(&numbers(&r.values, "values", &w, false)?);
            let k = field("binCount");
            let count = match k {
                Js::Undefined => None,
                Js::Num(n) if n.fract() == 0.0 && n.is_finite() && *n > 0.0 => Some(*n),
                other => {
                    return Err(format!("{w}: bin-count must be a whole number above 0, got {}.", js_string(other)));
                }
            };
            plot.bins = Some(histogram(&obs, count));
        }
        "BOXPLOT" => {
            plot.form = Form::Box;
            let values = field("values");
            let group = field("group");
            if is_nested(values) {
                if !group.is_undefined() {
                    return Err(format!(
                        "{w}: values is a list of lists, which already groups the observations by category. Remove group, or write values as one flat list with group."
                    ));
                }
                let rows = resolve(values, "values", &w, Shape::Nested)?.values;
                let mut nested = Vec::with_capacity(rows.len());
                for (j, row) in rows.iter().enumerate() {
                    let row = row.as_arr().cloned().unwrap_or_default();
                    nested.push(floats(&numbers(&row, &format!("values list {}", j + 1), &w, false)?));
                }
                plot.nested = Some(nested);
            } else {
                if matches!(values, Js::Str(_)) && group.is_undefined() {
                    resolve(values, "values", &w, Shape::Nested)?;
                }
                if !values.is_undefined() && group.is_undefined() {
                    return Err(format!(
                        "{w}: a BOXPLOT needs its observations grouped by category: values with group (the category of each value), or values as a list of lists, one per category."
                    ));
                }
                let r = need("values")?;
                column = r.column;
                let observations = floats(&numbers(&r.values, "values", &w, false)?);
                let groups = labels(&need("group")?.values, "group", &w)?;
                same_length(&w, &[("values", observations.len()), ("group", groups.len())])?;
                plot.observations = Some(observations);
                plot.groups = Some(groups);
            }
        }
        "CANDLESTICK" => {
            plot.form = Form::Candle;
            let open = need_numbers("open")?;
            let close = need_numbers("close")?;
            let low = need_numbers("low")?;
            let high = need_numbers("high")?;
            column = resolve(field("close"), "close", &w, Shape::Flat)?.column;
            same_length(&w, &[("open", open.len()), ("close", close.len()), ("low", low.len()), ("high", high.len())])?;
            let rule = "low must be at most both, and high at least both.";
            for (j, &o) in open.iter().enumerate() {
                let c = close[j];
                if low[j] > o.min(c) {
                    return Err(format!(
                        "{w}: row {} has low {} above its open ({}) or close ({}). {rule}",
                        j + 1,
                        num(low[j]),
                        num(o),
                        num(c)
                    ));
                }
                if high[j] < o.max(c) {
                    return Err(format!(
                        "{w}: row {} has high {} below its open ({}) or close ({}). {rule}",
                        j + 1,
                        num(high[j]),
                        num(o),
                        num(c)
                    ));
                }
            }
            plot.ohlc = Some([open, close, low, high]);
        }
        "HEATMAP" => {
            plot.form = Form::Heat;
            let values = field("values");
            if !field("x").is_undefined() || !field("y").is_undefined() {
                if is_nested(values) {
                    return Err(format!(
                        "{w}: write a HEATMAP either as a matrix (values as rows of cells) or as cells (x, y and values, one each), not both."
                    ));
                }
                if field("x").is_undefined() || field("y").is_undefined() || values.is_undefined() {
                    return Err(format!(
                        "{w}: a HEATMAP written as cells needs x, y and values, one of each per cell."
                    ));
                }
                let xs = labels(&resolve(field("x"), "x", &w, Shape::Flat)?.values, "x", &w)?;
                let ys = labels(&resolve(field("y"), "y", &w, Shape::Flat)?.values, "y", &w)?;
                let r = resolve(values, "values", &w, Shape::Flat)?;
                column = r.column;
                let vs = numbers(&r.values, "values", &w, true)?;
                same_length(&w, &[("x", xs.len()), ("y", ys.len()), ("values", vs.len())])?;
                plot.cell_x = Some(xs);
                plot.cell_y = Some(ys);
                plot.values = Some(vs);
            } else {
                if matches!(values, Js::Str(_)) {
                    resolve(values, "values", &w, Shape::Nested)?;
                }
                if !is_nested(values) {
                    return Err(format!(
                        "{w}: a HEATMAP needs values as a matrix — one list of cells per Y category, e.g. values [[1 2] [3 4]] — or x, y and values, one of each per cell."
                    ));
                }
                let rows = resolve(values, "values", &w, Shape::Nested)?.values;
                let mut matrix = Vec::with_capacity(rows.len());
                for (j, row) in rows.iter().enumerate() {
                    let row = row.as_arr().cloned().unwrap_or_default();
                    matrix.push(numbers(&row, &format!("values row {}", j + 1), &w, true)?);
                }
                plot.matrix = Some(matrix);
            }
        }
        "GAUGE" => {
            plot.form = Form::Gauge;
            if field("value").is_undefined() {
                return Err(format!("{w}: a GAUGE plot needs value, e.g. plot kind GAUGE value 72 {{}}."));
            }
            let min = field("minValue").or(Js::Num(0.0));
            let max = field("maxValue").or(Js::Num(100.0));
            for (word, v) in [("min-value", &min), ("max-value", &max)] {
                if !matches!(v, Js::Num(n) if n.is_finite()) {
                    return Err(format!("{w}: {word} must be a number for a GAUGE, got {}.", qs(&js_string(v))));
                }
            }
            let (min, max) = (min.as_num().unwrap_or(0.0), max.as_num().unwrap_or(0.0));
            if !(min < max) {
                return Err(format!("{w}: min-value ({}) must be less than max-value ({}).", num(min), num(max)));
            }
            let value = match field("value") {
                Js::Num(n) if n.is_finite() => *n,
                other => return Err(format!("{w}: value must be a finite number, got {}.", js_string(other))),
            };
            if value < min || value > max {
                return Err(format!(
                    "{w}: value {} is off the dial, which runs from {} to {}. Set min-value or max-value to include it.",
                    num(value),
                    num(min),
                    num(max)
                ));
            }
            plot.gauge = Some((value, min, max));
        }
        _ => {
            plot.form = Form::Radar;
            let r = need("values")?;
            column = r.column;
            plot.values = Some(numbers(&r.values, "values", &w, false)?);
        }
    }

    let xy = plot.form == Form::Xy;
    if xy && let (Some(x), Some(y)) = (&plot.x, &plot.y) {
        same_length(&w, &[("x", x.len()), ("y", y.len())])?;
    }
    if let Some(names) = &plot.names {
        let (b, bv) = if xy { ("y", plot.y.as_ref()) } else { ("values", plot.values.as_ref()) };
        if let Some(bv) = bv {
            same_length(&w, &[("names", names.len()), (b, bv.len())])?;
        }
    }
    if !field("stack").is_undefined() && plot.form != Form::Category {
        return Err(format!("{w}: stack groups plots over categories; it does not apply to a plot of x/y pairs."));
    }
    plot.name = field("name").or(column.unwrap_or(Js::Undefined)).or(Js::Str(format!("Series {}", i + 1)));
    Ok(plot)
}

/// How many category steps a plot on a category axis fills.
fn steps(p: &Plot) -> usize {
    match p.form {
        Form::Candle => p.ohlc.as_ref().map_or(0, |o| o[0].len()),
        Form::Box => p.nested.as_ref().map_or(0, Vec::len),
        _ => p.values.as_ref().map_or(0, Vec::len),
    }
}

fn cell_values(values: &[f64]) -> Vec<Js> {
    values.iter().map(|&v| Js::Num(v)).collect()
}

/// Binds a Cartesian plot to its axes and checks each value against the axis it lands on.
fn bind_plot(plot: &mut Plot, axes: &mut [Axis]) -> R<()> {
    let w = plot.place.clone();
    let xa = bind_axis(plot.src.get("xAxis"), "X", axes, &w)?;
    let ya = bind_axis(plot.src.get("yAxis"), "Y", axes, &w)?;
    plot.x_axis = Some(xa);
    plot.y_axis = Some(ya);
    if plot.form == Form::Xy {
        if axes[xa].scale == "CATEGORY" || axes[ya].scale == "CATEGORY" {
            let on = if axes[xa].scale == "CATEGORY" { xa } else { ya };
            return Err(format!(
                "{w}: a {} of x/y pairs is drawn on numeric or time axes; axis {} is CATEGORY.",
                plot.kind,
                q(&axes[on].id)
            ));
        }
        if axes[ya].scale == "TIME" {
            return Err(format!(
                "{w}: y values are drawn on axis {}, which is TIME; the Y axis of x/y pairs must be LINEAR or LOG.",
                q(&axes[ya].id)
            ));
        }
        let x = plot.x.take().unwrap_or_default();
        plot.x = Some(if axes[xa].scale == "TIME" { time_values(&x, "x", &w)? } else { numbers(&x, "x", &w, false)? });
        if axes[xa].scale == "LOG" {
            positive_on_log(plot.x.as_deref().unwrap_or_default(), "x", &axes[xa], &w)?;
        }
        if axes[ya].scale == "LOG" {
            positive_on_log(plot.y.as_deref().unwrap_or_default(), "y", &axes[ya], &w)?;
        }
        return Ok(());
    }
    let cats: Vec<usize> = [xa, ya].into_iter().filter(|&a| axes[a].scale == "CATEGORY").collect();
    if cats.len() != 1 {
        return Err(if cats.is_empty() {
            let of = if plot.form == Form::Category { format!("{} of values", plot.kind) } else { plot.kind.clone() };
            let line = if plot.kind == "LINE" {
                " For a LINE over numbers or dates, write x and y instead of values."
            } else {
                ""
            };
            format!(
                "{w}: a {of} needs a CATEGORY axis for its steps; axes {} and {} are {} and {}.{line}",
                q(&axes[xa].id),
                q(&axes[ya].id),
                axes[xa].scale,
                axes[ya].scale
            )
        } else {
            format!(
                "{w}: both of its axes are CATEGORY; a {} needs one CATEGORY axis for its steps and one numeric axis for its values.",
                plot.kind
            )
        });
    }
    let base = cats[0];
    plot.base = Some(base);
    let value_axis = if base == xa { ya } else { xa };
    if axes[value_axis].scale == "TIME" {
        return Err(format!(
            "{w}: values are drawn on axis {}, which is TIME; use LINEAR or LOG for values.",
            q(&axes[value_axis].id)
        ));
    }
    let log = axes[value_axis].scale == "LOG";
    if plot.form == Form::Category && log {
        positive_on_log(plot.values.as_deref().unwrap_or_default(), "values", &axes[value_axis], &w)?;
    }
    if plot.form == Form::Candle
        && log
        && let Some(ohlc) = &plot.ohlc
    {
        for (k, values) in ["open", "close", "low", "high"].into_iter().zip(ohlc) {
            positive_on_log(&cell_values(values), k, &axes[value_axis], &w)?;
        }
    }
    if plot.form == Form::Box {
        if let (Some(groups), Some(observations)) = (&plot.groups, &plot.observations) {
            // The flat form: groups follow the axis's categories when given, else first-seen order.
            if let Some(categories) = &axes[base].categories {
                for (j, g) in groups.iter().enumerate() {
                    if !categories.contains(g) {
                        let listed: Vec<String> = categories.iter().map(|c| qs(c)).collect();
                        return Err(format!(
                            "{w}: group item {} is {}, which is not a category of axis {}. Its categories are: {}.",
                            j + 1,
                            qs(g),
                            q(&axes[base].id),
                            listed.join(", ")
                        ));
                    }
                }
            } else {
                let mut unique: Vec<String> = Vec::new();
                for g in groups {
                    if !unique.contains(g) {
                        unique.push(g.clone());
                    }
                }
                axes[base].categories = Some(unique);
            }
            let categories = axes[base].categories.clone().unwrap_or_default();
            plot.nested = Some(
                categories
                    .iter()
                    .map(|c| observations.iter().zip(groups).filter(|(_, g)| *g == c).map(|(v, _)| *v).collect())
                    .collect(),
            );
        }
        if log && let Some(nested) = &plot.nested {
            for row in nested {
                positive_on_log(&cell_values(row), "values", &axes[value_axis], &w)?;
            }
        }
    }
    Ok(())
}

/// A CATEGORY axis's steps: as written, or 1..n when left out; every plot on it must fit.
fn settle_categories(axis: usize, plots: &[Plot], axes: &mut [Axis], place: &str) -> R<()> {
    let on: Vec<&Plot> = plots.iter().filter(|p| p.base == Some(axis)).collect();
    if let Some(categories) = &axes[axis].categories {
        let k = categories.len();
        for p in &on {
            let n = steps(p);
            if n == k {
                continue;
            }
            let id = q(&axes[axis].id);
            return Err(match p.form {
                Form::Box => format!(
                    "{}: has {n} lists of values but axis {id} has {k} categories. Give one list per category ([] for none).",
                    p.place
                ),
                Form::Candle => format!(
                    "{}: has {} but axis {id} has {k} categories. Give one open, close, low and high per category.",
                    p.place,
                    plural(n, "row")
                ),
                _ => format!(
                    "{}: has {n} values but axis {id} has {k} categories. Give one value per category (null for a gap).",
                    p.place
                ),
            });
        }
        return Ok(());
    }
    let mut lengths: Vec<usize> = Vec::new();
    for p in &on {
        let n = steps(p);
        if !lengths.contains(&n) {
            lengths.push(n);
        }
    }
    if lengths.len() > 1 {
        let listed: Vec<String> = on.iter().map(|p| format!("{}: {}", q(&p.id), steps(p))).collect();
        return Err(format!(
            "{place}: plots on axis {} have different lengths ({}). Give the axis categories, one per value.",
            q(&axes[axis].id),
            listed.join(", ")
        ));
    }
    axes[axis].categories = Some((1..=lengths.first().copied().unwrap_or(0)).map(|j| j.to_string()).collect());
    Ok(())
}

/* ------------------------------------------------------------------ families */

/// Which plots may share this chart: one family, and within the one-plot families one plot.
fn check_families(plots: &[Plot], place: &str) -> R<Family> {
    let Some(si) = plots.iter().position(|p| family(&p.kind) != Family::Cartesian) else {
        return Ok(Family::Cartesian);
    };
    let special = &plots[si];
    let fam = family(&special.kind);
    let other = plots
        .iter()
        .enumerate()
        .find(|(j, p)| *j != si && (family(&p.kind) != fam || (fam == Family::Single && p.kind != special.kind)));
    if let Some((_, other)) = other {
        return Err(format!(
            "{place}: a {} cannot share a chart with {} plots. Put the {} in its own chart in the collection.",
            special.kind,
            other.kind,
            special.kind.to_lowercase()
        ));
    }
    if fam == Family::Single && plots.len() > 1 {
        return Err(format!(
            "{place}: a chart holds one {}; put each {} in its own chart.",
            special.kind,
            special.kind.to_lowercase()
        ));
    }
    if fam == Family::Gauge && plots.len() > MAX_GAUGES {
        return Err(format!(
            "{place}: a chart holds at most {MAX_GAUGES} gauges side by side; this one has {}. Put the rest in another chart.",
            plots.len()
        ));
    }
    Ok(fam)
}

/// A HISTOGRAM's axes are generated; an author may only name them (and pick their ids).
fn histogram_axes(recs: &[Js], plot: &mut Plot, place: &str, resolve: &Resolve<'_>) -> R<Vec<Axis>> {
    let mut by_dir: HashMap<String, Js> = HashMap::new();
    for (i, rec) in recs.iter().enumerate() {
        let id = rec.prop("id")?;
        let w = format!("{place} axis {}", if id.truthy() { q(id) } else { (i + 1).to_string() });
        let direction = rec.get("direction");
        let want = match direction.as_str() {
            Some("X") => "CATEGORY",
            Some("Y") => "LINEAR",
            _ => {
                let shown = if direction.is_nullish() {
                    "an axis without a direction".to_owned()
                } else {
                    js_string(direction)
                };
                return Err(format!("{w}: a HISTOGRAM is drawn on one X axis and one Y axis, not {shown}."));
            }
        };
        let dir = text(direction);
        if let Some(extra) = keys(rec)
            .into_iter()
            .map(|k| source_word(&k))
            .find(|k| !["id", "direction", "scale", "name"].contains(&k.as_str()))
        {
            return Err(format!(
                "{w}: a HISTOGRAM's axes are generated — bins across a CATEGORY X axis, counts up a LINEAR Y axis — so an axis here takes only id, direction, scale and name, not `{extra}`."
            ));
        }
        if by_dir.contains_key(&dir) {
            return Err(format!("{place}: a HISTOGRAM has one {dir} axis; remove the others."));
        }
        let scale = rec.get("scale");
        if !scale.is_undefined() && text(scale) != want {
            return Err(format!("{w}: a HISTOGRAM's {dir} axis is {want}, not {}.", js_string(scale)));
        }
        by_dir.insert(dir, rec.clone());
    }
    let generated = |dir: &str, scale: &str| {
        let mut rec = by_dir.get(dir).and_then(Js::as_obj).cloned().unwrap_or_default();
        rec.insert("direction".into(), Js::str(dir));
        rec.insert("scale".into(), Js::str(scale));
        Js::Obj(rec)
    };
    let mut axes = normalize_axes(&[generated("X", "CATEGORY"), generated("Y", "LINEAR")], place, resolve, "LINEAR")?;
    let xa = bind_axis(plot.src.get("xAxis"), "X", &axes, &plot.place)?;
    let ya = bind_axis(plot.src.get("yAxis"), "Y", &axes, &plot.place)?;
    plot.x_axis = Some(xa);
    plot.y_axis = Some(ya);
    plot.base = Some(xa);
    axes[xa].categories = plot.bins.as_ref().map(|b| b.labels.clone());
    Ok(axes)
}

/// A HEATMAP: both axes CATEGORY; cells become `[xIndex, yIndex, value]`, empty cells left out.
fn bind_heatmap(plot: &mut Plot, axes: &mut [Axis]) -> R<()> {
    let w = plot.place.clone();
    let xa = bind_axis(plot.src.get("xAxis"), "X", axes, &w)?;
    let ya = bind_axis(plot.src.get("yAxis"), "Y", axes, &w)?;
    plot.x_axis = Some(xa);
    plot.y_axis = Some(ya);
    for a in [xa, ya] {
        if axes[a].scale != "CATEGORY" {
            return Err(format!(
                "{w}: a HEATMAP is a grid of categories, so both axes are CATEGORY; axis {} is {}.",
                q(&axes[a].id),
                axes[a].scale
            ));
        }
    }
    let mut cells: Vec<[f64; 3]> = Vec::new();
    if let Some(matrix) = &plot.matrix {
        for a in [xa, ya] {
            if axes[a].categories.is_none() {
                return Err(format!(
                    "{w}: a HEATMAP written as a matrix needs categories on both axes, to name its rows and columns. Axis {} has none.",
                    q(&axes[a].id)
                ));
            }
        }
        let cols = axes[xa].categories.as_ref().map_or(0, Vec::len);
        let rows = axes[ya].categories.as_ref().map_or(0, Vec::len);
        if matrix.len() != rows {
            return Err(format!(
                "{w}: values has {} but axis {} has {rows} categories. A HEATMAP matrix has one row per Y category.",
                plural(matrix.len(), "row"),
                q(&axes[ya].id)
            ));
        }
        for (yi, row) in matrix.iter().enumerate() {
            if row.len() != cols {
                return Err(format!(
                    "{w}: values row {} has {} but axis {} has {cols} categories. Each row has one cell per X category (null for none).",
                    yi + 1,
                    plural(row.len(), "cell"),
                    q(&axes[xa].id)
                ));
            }
            for (xi, v) in row.iter().enumerate() {
                if let Js::Num(v) = v {
                    cells.push([xi as f64, yi as f64, *v]);
                }
            }
        }
    } else {
        let xs = plot.cell_x.clone().unwrap_or_default();
        let ys = plot.cell_y.clone().unwrap_or_default();
        let index = |a: &mut Axis, vals: &[String], prop: &str| -> R<Vec<usize>> {
            if a.categories.is_none() {
                let mut unique: Vec<String> = Vec::new();
                for v in vals {
                    if !unique.contains(v) {
                        unique.push(v.clone());
                    }
                }
                a.categories = Some(unique);
            }
            let categories = a.categories.as_ref().expect("categories are set");
            vals.iter()
                .enumerate()
                .map(|(j, v)| {
                    categories.iter().position(|c| c == v).ok_or_else(|| {
                        let listed: Vec<String> = categories.iter().map(|c| qs(c)).collect();
                        format!(
                            "{w}: {prop} item {} is {}, which is not a category of axis {}. Its categories are: {}.",
                            j + 1,
                            qs(v),
                            q(&a.id),
                            listed.join(", ")
                        )
                    })
                })
                .collect()
        };
        let xi = index(&mut axes[xa], &xs, "x")?;
        let yi = index(&mut axes[ya], &ys, "y")?;
        let values = plot.values.clone().unwrap_or_default();
        let mut seen: HashMap<(usize, usize), usize> = HashMap::new();
        for (j, &x) in xi.iter().enumerate() {
            let key = (x, yi[j]);
            if let Some(first) = seen.get(&key) {
                return Err(format!(
                    "{w}: the cell ({}, {}) is given twice, at items {} and {}. Give each cell once.",
                    qs(&xs[j]),
                    qs(&ys[j]),
                    first + 1,
                    j + 1
                ));
            }
            seen.insert(key, j);
            if let Js::Num(v) = values[j] {
                cells.push([x as f64, yi[j] as f64, v]);
            }
        }
    }
    plot.cells = Some(cells);
    Ok(())
}

/// RADAR bounds: min defaults to 0; max is explicit, or a round number above the largest value.
fn radar_bounds(axis: &Axis, plots: &[Plot]) -> R<(f64, f64)> {
    let min = axis.min_value.as_num().unwrap_or(0.0);
    let spokes = axis.categories.as_ref().map_or(0, Vec::len);
    for p in plots {
        let n = p.values.as_ref().map_or(0, Vec::len);
        if n != spokes {
            return Err(format!(
                "{}: has {n} values but axis {} has {spokes} spokes. Give one value per spoke.",
                p.place,
                q(&axis.id)
            ));
        }
    }
    let values = |p: &Plot| floats(p.values.as_deref().unwrap_or_default());
    let max = match axis.max_value.as_num() {
        Some(max) => max,
        None => {
            let mut top = f64::NEG_INFINITY;
            for p in plots {
                for v in values(p) {
                    if v > top {
                        top = v;
                    }
                }
            }
            let max = if top > min { min + nice_ceil(top - min) } else { min + 1.0 };
            // At large magnitudes `min + 1` is `min`, and the round number or the sum can overflow.
            if !(max.is_finite() && min < max) {
                return Err(format!(
                    "{}: no max-value can be chosen above min-value {} for these values: at this size, no round number above them can be represented. Write both min-value and max-value on the axis.",
                    axis.place,
                    num(min)
                ));
            }
            max
        }
    };
    for p in plots {
        for (j, v) in values(p).into_iter().enumerate() {
            if v < min || v > max {
                let hint = if v < min && axis.min_value.is_undefined() {
                    " A RADIAL axis starts at 0 unless you set min-value.".to_owned()
                } else {
                    format!(" Widen the axis's {} to include it.", if v < min { "min-value" } else { "max-value" })
                };
                return Err(format!(
                    "{}: values item {} is {}, outside axis {}, which runs from {} to {}.{hint}",
                    p.place,
                    j + 1,
                    num(v),
                    q(&axis.id),
                    num(min),
                    num(max)
                ));
            }
        }
    }
    Ok((min, max))
}

/* ------------------------------------------------------------------ lowering */

fn axis_type(scale: &str) -> &'static str {
    match scale {
        "CATEGORY" => "category",
        "LINEAR" => "value",
        "LOG" => "log",
        "TIME" => "time",
        _ => "undefined",
    }
}

fn strings(xs: &[String]) -> Js {
    Js::Arr(xs.iter().map(Js::from).collect())
}

fn lower_axis(a: &Axis, extra: Obj) -> Obj {
    let mut out = obj! {
        "id" => &a.id,
        "type" => axis_type(&a.scale),
        "gridIndex" => 0.0,
        "position" => a.position.to_lowercase(),
    };
    if a.offset != 0.0 {
        out.insert("offset".into(), Js::Num(a.offset));
    }
    if let Some(categories) = &a.categories {
        out.insert("data".into(), strings(categories));
    }
    if !a.name.is_undefined() {
        out.insert("name".into(), a.name.clone());
        out.insert("nameLocation".into(), Js::str("middle"));
    }
    if !a.min_value.is_undefined() {
        out.insert("min".into(), a.min_value.clone());
    }
    if !a.max_value.is_undefined() {
        out.insert("max".into(), a.max_value.clone());
    }
    if a.inverse.truthy() {
        out.insert("inverse".into(), Js::Bool(true));
    }
    if !a.rotate.is_undefined() {
        out.insert("axisLabel".into(), Js::Obj(obj! { "rotate" => &a.rotate }));
    }
    out.extend(extra);
    out
}

/// Series ids are generated, never an authored id as written: `p:<plot id>` for a plot's
/// series, `g:<plot id>:<role>` for a series it adds.
fn plot_id(p: &Plot) -> String {
    format!("p:{}", js_string(&p.id))
}

fn slice_colors(p: &Plot, noun: &str) -> R<Option<Vec<String>>> {
    let colors = p.src.get("colors");
    if colors.is_undefined() {
        return Ok(None);
    }
    let colors = resolve_colors(colors, &format!("{} colors", p.place))?;
    let n = p.names.as_ref().map_or(0, Vec::len);
    if colors.len() != n {
        return Err(format!("{}: colors has {} colours but there are {n} {noun}.", p.place, colors.len()));
    }
    Ok(Some(colors))
}

struct Frame {
    pie_center: [String; 2],
    r#box: Obj,
    /// This plot's place among the chart's plots, for gauges side by side.
    slot: (usize, usize),
}

fn spread(target: &mut Obj, source: &Obj) {
    for (k, v) in source {
        target.insert(k.clone(), v.clone());
    }
}

fn lower_series(p: &Plot, label: Option<Obj>, frame: &Frame, axes: &[Axis]) -> R<Vec<Js>> {
    let r = &p.src;
    let color = if r.get("color").is_undefined() {
        None
    } else {
        Some(resolve_color(r.get("color"), &format!("{} color", p.place))?)
    };
    let mut common = obj! { "id" => plot_id(p), "name" => &p.name };
    if let Some(color) = color.as_ref().filter(|c| !c.is_empty()) {
        common.insert("color".into(), Js::str(color));
    }
    if let Some(label) = label {
        common.insert("label".into(), Js::Obj(label));
    }
    let slices = |noun: &str| -> R<Js> {
        let colors = slice_colors(p, noun)?;
        let values = p.values.as_deref().unwrap_or_default();
        Ok(Js::Arr(
            p.names
                .as_deref()
                .unwrap_or_default()
                .iter()
                .enumerate()
                .map(|(j, name)| {
                    let mut slice = obj! { "name" => name, "value" => values.get(j).cloned().unwrap_or(Js::Undefined) };
                    if let Some(colors) = &colors {
                        slice.insert("itemStyle".into(), Js::Obj(obj! { "color" => &colors[j] }));
                    }
                    Js::Obj(slice)
                })
                .collect(),
        ))
    };
    let mut series = common.clone();
    match p.kind.as_str() {
        "PIE" => {
            let outer = r.get("radius").or(Js::str("70%"));
            series.insert("type".into(), Js::str("pie"));
            series.insert("data".into(), slices("slices")?);
            let inner = r.get("innerRadius");
            series.insert(
                "radius".into(),
                if inner.is_undefined() { outer } else { Js::Arr(vec![inner.clone(), outer]) },
            );
            series.insert("center".into(), strings(&frame.pie_center));
            if r.get("rose").truthy() {
                series.insert("roseType".into(), Js::Str(text(r.get("rose")).to_lowercase()));
            }
            if !r.get("startAngle").is_undefined() {
                series.insert("startAngle".into(), r.get("startAngle").clone());
            }
            return Ok(vec![Js::Obj(series)]);
        }
        "FUNNEL" => {
            series.insert("type".into(), Js::str("funnel"));
            series.insert("sort".into(), Js::str("descending"));
            spread(&mut series, &frame.r#box);
            series.insert("data".into(), slices("stages")?);
            return Ok(vec![Js::Obj(series)]);
        }
        "GAUGE" => {
            let (i, n) = frame.slot;
            let (value, min, max) = p.gauge.unwrap_or((0.0, 0.0, 100.0));
            series.insert("type".into(), Js::str("gauge"));
            series.insert(
                "center".into(),
                Js::Arr(vec![Js::Str(format!("{}%", num(((i as f64 + 0.5) / n as f64) * 100.0))), Js::str("55%")]),
            );
            series.insert("radius".into(), Js::Str(format!("{}%", num(75f64.min(90.0 / n as f64)))));
            series.insert("min".into(), Js::Num(min));
            series.insert("max".into(), Js::Num(max));
            series.insert(
                "data".into(),
                Js::Arr(vec![Js::Obj(obj! { "value" => value, "name" => r.get("name").or(Js::str("")) })]),
            );
            // Side by side, a dial's tick labels and split lines crowd it; several gauges show
            // only the arc, the pointer, the name and the reading.
            if n > 1 {
                let center = |y: &str| Js::Arr(vec![Js::Num(0.0), Js::str(y)]);
                spread(
                    &mut series,
                    &obj! {
                        "axisLabel" => obj! { "show" => false },
                        "splitLine" => obj! { "length" => 6.0 },
                        "axisTick" => obj! { "show" => false },
                        "title" => obj! { "offsetCenter" => center("70%"), "fontSize" => 12.0 },
                        "detail" => obj! { "offsetCenter" => center("40%"), "fontSize" => 18.0 },
                    },
                );
            }
            if let Some(color) = color.as_ref().filter(|c| !c.is_empty()) {
                series.insert("itemStyle".into(), Js::Obj(obj! { "color" => color }));
                series.insert("progress".into(), Js::Obj(obj! { "show" => true }));
            }
            return Ok(vec![Js::Obj(series)]);
        }
        "RADAR" => {
            let mut datum = obj! { "name" => &p.name, "value" => Js::Arr(p.values.clone().unwrap_or_default()) };
            if r.get("area").truthy() {
                datum.insert("areaStyle".into(), Js::Obj(Obj::new()));
            }
            series.insert("type".into(), Js::str("radar"));
            series.insert("data".into(), Js::Arr(vec![Js::Obj(datum)]));
            return Ok(vec![Js::Obj(series)]);
        }
        _ => {}
    }
    let (xa, ya) = (p.x_axis.unwrap_or(0), p.y_axis.unwrap_or(0));
    let indices = obj! { "xAxisIndex" => axes[xa].index, "yAxisIndex" => axes[ya].index };
    spread(&mut series, &indices);
    let triples = |rows: &[Vec<f64>]| Js::Arr(rows.iter().map(|row| Js::Arr(cell_values(row))).collect());
    match p.kind.as_str() {
        "HEATMAP" => {
            series.insert("type".into(), Js::str("heatmap"));
            let cells: Vec<Vec<f64>> = p.cells.as_deref().unwrap_or_default().iter().map(|c| c.to_vec()).collect();
            series.insert("data".into(), triples(&cells));
            return Ok(vec![Js::Obj(series)]);
        }
        "HISTOGRAM" => {
            // Touching bars: the bins are adjacent ranges, not separate categories.
            series.insert("type".into(), Js::str("bar"));
            series.insert("barCategoryGap".into(), Js::str("0%"));
            series.insert("data".into(), Js::Arr(cell_values(p.bins.as_ref().map_or(&[][..], |b| &b.counts))));
            series.insert(
                "itemStyle".into(),
                Js::Obj(obj! { "borderColor" => "rgba(128,128,128,0.35)", "borderWidth" => 1.0 }),
            );
            return Ok(vec![Js::Obj(series)]);
        }
        _ => {}
    }
    let vertical = p.base == p.x_axis;
    let layout = if vertical { "horizontal" } else { "vertical" };
    match p.kind.as_str() {
        "BOXPLOT" => {
            let stats: Vec<_> = p.nested.as_deref().unwrap_or_default().iter().map(|row| boxplot(row)).collect();
            let mut outliers = Vec::new();
            for (j, s) in stats.iter().enumerate() {
                for &v in &s.outliers {
                    let j = j as f64;
                    outliers.push(Js::Arr(cell_values(&if vertical { [j, v] } else { [v, j] })));
                }
            }
            series.insert("type".into(), Js::str("boxplot"));
            series.insert("layout".into(), Js::str(layout));
            series.insert(
                "data".into(),
                Js::Arr(stats.iter().map(|s| Js::Arr(s.r#box.map(|b| cell_values(&b)).unwrap_or_default())).collect()),
            );
            // Both series carry the plot's name, so one legend entry toggles the box and its
            // outliers, and the palette (assigned by name) colours them alike.
            let mut scatter = obj! { "id" => format!("g:{}:outliers", js_string(&p.id)), "name" => &p.name };
            if let Some(color) = color.as_ref().filter(|c| !c.is_empty()) {
                scatter.insert("color".into(), Js::str(color));
            }
            spread(&mut scatter, &indices);
            scatter.insert("type".into(), Js::str("scatter"));
            scatter.insert("data".into(), Js::Arr(outliers));
            return Ok(vec![Js::Obj(series), Js::Obj(scatter)]);
        }
        "CANDLESTICK" => {
            let [open, close, low, high] = p.ohlc.clone().unwrap_or_default();
            // Rising green, falling red: ECharts defaults to the reverse.
            let (up, down) = ("#16a34a", "#dc2626");
            series.insert("type".into(), Js::str("candlestick"));
            series.insert("layout".into(), Js::str(layout));
            series.insert(
                "itemStyle".into(),
                Js::Obj(obj! { "color" => up, "color0" => down, "borderColor" => up, "borderColor0" => down }),
            );
            let rows: Vec<Vec<f64>> = (0..open.len()).map(|j| vec![open[j], close[j], low[j], high[j]]).collect();
            series.insert("data".into(), triples(&rows));
            return Ok(vec![Js::Obj(series)]);
        }
        _ => {}
    }
    let pairs: Option<Vec<Js>> = (p.form == Form::Xy).then(|| {
        let (x, y) = (p.x.as_deref().unwrap_or_default(), p.y.as_deref().unwrap_or_default());
        x.iter()
            .enumerate()
            .map(|(j, x)| Js::Arr(vec![x.clone(), y.get(j).cloned().unwrap_or(Js::Undefined)]))
            .collect()
    });
    if p.kind == "BAR" {
        let values = p.values.clone().unwrap_or_default();
        let colors = if r.get("colors").is_undefined() {
            None
        } else {
            Some(resolve_colors(r.get("colors"), &format!("{} colors", p.place))?)
        };
        if let Some(colors) = &colors
            && colors.len() != values.len()
        {
            return Err(format!(
                "{}: colors has {} colours but there are {} bars.",
                p.place,
                colors.len(),
                values.len()
            ));
        }
        series.insert("type".into(), Js::str("bar"));
        let data = match &colors {
            Some(colors) => Js::Arr(
                values
                    .iter()
                    .enumerate()
                    .map(|(j, v)| Js::Obj(obj! { "value" => v, "itemStyle" => obj! { "color" => &colors[j] } }))
                    .collect(),
            ),
            None => Js::Arr(values),
        };
        series.insert("data".into(), data);
        if !r.get("stack").is_undefined() {
            series.insert("stack".into(), r.get("stack").clone());
        }
        if !r.get("barWidth").is_undefined() {
            series.insert("barWidth".into(), r.get("barWidth").clone());
        }
        return Ok(vec![Js::Obj(series)]);
    }
    let symbol = r.get("symbol");
    if !symbol.is_undefined() {
        let s = text(symbol);
        series.insert("symbol".into(), Js::Str(if s == "RECT" { "rect".to_owned() } else { s.to_lowercase() }));
    }
    if !r.get("symbolSize").is_undefined() {
        series.insert("symbolSize".into(), r.get("symbolSize").clone());
    }
    if p.kind == "LINE" {
        series.insert("type".into(), Js::str("line"));
        series.insert("data".into(), Js::Arr(pairs.unwrap_or_else(|| p.values.clone().unwrap_or_default())));
        series.insert("connectNulls".into(), Js::Bool(false));
        if r.get("smooth").truthy() {
            series.insert("smooth".into(), Js::Bool(true));
        }
        if r.get("area").truthy() {
            series.insert("areaStyle".into(), Js::Obj(Obj::new()));
        }
        if !r.get("step").is_undefined() {
            series.insert("step".into(), Js::Str(text(r.get("step")).to_lowercase()));
        }
        if !r.get("stack").is_undefined() {
            series.insert("stack".into(), r.get("stack").clone());
        }
        return Ok(vec![Js::Obj(series)]);
    }
    series.insert("type".into(), Js::str("scatter"));
    let pairs = pairs.unwrap_or_default();
    let data = match &p.names {
        Some(names) => Js::Arr(
            pairs
                .into_iter()
                .enumerate()
                .map(|(j, value)| Js::Obj(obj! { "name" => &names[j], "value" => value }))
                .collect(),
        ),
        None => Js::Arr(pairs),
    };
    series.insert("data".into(), data);
    Ok(vec![Js::Obj(series)])
}

/// Whether a plot has nothing to draw. A gauge always has its reading.
fn is_empty(p: &Plot) -> bool {
    let any_number = |vs: Option<&Vec<Js>>| vs.is_some_and(|vs| vs.iter().any(|v| !matches!(v, Js::Null)));
    match p.form {
        Form::Slices => !p.values.as_deref().unwrap_or_default().iter().any(|v| v.as_num().is_some_and(|n| n > 0.0)),
        Form::Xy => !any_number(p.y.as_ref()),
        Form::Hist => p.bins.as_ref().is_none_or(|b| b.counts.is_empty()),
        Form::Box => p.nested.as_ref().is_none_or(|n| n.iter().all(Vec::is_empty)),
        Form::Candle => p.ohlc.as_ref().is_none_or(|o| o[0].is_empty()),
        Form::Heat => p.cells.as_ref().is_none_or(Vec::is_empty),
        Form::Gauge => false,
        Form::Category | Form::Radar => !any_number(p.values.as_ref()),
    }
}

fn kind_word(kind: &str) -> &'static str {
    match kind {
        "BAR" => "bar",
        "LINE" => "line",
        "PIE" => "pie",
        "SCATTER" => "scatter",
        "HISTOGRAM" => "histogram",
        "BOXPLOT" => "box",
        "CANDLESTICK" => "candlestick",
        "HEATMAP" => "heatmap",
        "FUNNEL" => "funnel",
        "GAUGE" => "gauge",
        "RADAR" => "radar",
        _ => "undefined",
    }
}

/// A one-sentence summary for screen readers, when the author gave no description.
fn summarize(title: &Js, name: &Js, plots: &[Plot], axes: &[Axis]) -> String {
    let head = js_string(&title.or(name.clone()));
    let p0 = &plots[0];
    let names = p0.names.as_ref().map_or(0, Vec::len);
    match p0.kind.as_str() {
        "PIE" => return format!("{head}: a pie chart of {names} slices."),
        "FUNNEL" => return format!("{head}: a funnel of {names} stages."),
        "HISTOGRAM" => {
            let counts = p0.bins.as_ref().map_or(&[][..], |b| &b.counts);
            return format!(
                "{head}: a histogram of {} values in {} bins.",
                num(counts.iter().sum::<f64>()),
                counts.len()
            );
        }
        "HEATMAP" => {
            let count = |a: Option<usize>| a.and_then(|a| axes[a].categories.as_ref()).map_or(0, Vec::len);
            return format!("{head}: a heatmap of {} by {} cells.", count(p0.x_axis), count(p0.y_axis));
        }
        _ => {}
    }
    let parts: Vec<String> = plots
        .iter()
        .map(|p| match (p.kind.as_str(), p.gauge) {
            ("GAUGE", Some((value, _, _))) => format!("gauge {} reading {}", q(&p.name), num(value)),
            (kind, _) => format!("{} plot {}", kind_word(kind), q(&p.name)),
        })
        .collect();
    format!("{head}: {}.", list_of(&parts))
}

/* ------------------------------------------------------------------ chart */

/// The colours every chart in the collection shares.
pub struct Look {
    pub palette: Option<Vec<String>>,
    pub background: Option<String>,
}

fn items(part: &Js) -> R<Vec<Js>> {
    Ok(part.prop("items")?.as_arr().cloned().unwrap_or_default())
}

/// Builds one chart: `{id, name, option, view}`.
pub fn build_chart(chart: &Js, id: &Js, name: &Js, place: &str, shared: &Scope, look: &Look) -> R<Js> {
    let parts = chart.prop("parts")?;
    let settings = chart.prop("settings")?;
    let datasets = parts.prop("datasets")?;
    let local = scope_datasets(
        &if datasets.is_nullish() { Vec::new() } else { items(datasets)? },
        &format!("{place} datasets"),
    )?;
    let selection: Selection = select_dataset(shared, &local, settings.prop("datasetId")?, place)?;
    let resolve = |v: &Js, prop: &str, w: &str, shape: Shape| resolve_data(v, prop, &selection, w, shape);

    // Plots, and which of them may share this chart.
    let mut plots: Vec<Plot> = Vec::new();
    for (i, rec) in items(parts.prop("plots")?)?.iter().enumerate() {
        plots.push(normalize_plot(rec, i, place, &resolve)?);
    }
    for (i, p) in plots.iter().enumerate() {
        if plots[..i].iter().any(|o| same_value_zero(&o.id, &p.id)) {
            return Err(format!("{place}: two plots have the id {}. Give each plot its own id.", q(&p.id)));
        }
    }
    let fam = check_families(&plots, place)?;
    let single = fam == Family::Single;
    let sliced = single && plots[0].form == Form::Slices;
    let heat = single && plots[0].kind == "HEATMAP";

    // Axes, by family.
    let axes_part = parts.get("axes");
    let axis_recs =
        |default: Vec<Js>| -> R<Vec<Js>> { if axes_part.is_nullish() { Ok(default) } else { items(axes_part) } };
    let need_xy = |axes: &[Axis]| -> R<()> {
        for d in ["X", "Y"] {
            if !axes.iter().any(|a| a.direction == d) {
                return Err(format!("{place}: axes has no {d} axis. Add axis direction {d} … {{}}."));
            }
        }
        if let Some(radial) = axes.iter().find(|a| a.direction == "RADIAL") {
            return Err(format!(
                "{}: a RADIAL axis holds the spokes of RADAR plots, and this chart's plots are {}. Remove it, or put the radar in its own chart.",
                radial.place, plots[0].kind
            ));
        }
        Ok(())
    };
    let mut axes: Vec<Axis> = Vec::new();
    let mut radar: Option<(usize, f64, f64)> = None;
    if fam == Family::Cartesian {
        if axes_part.truthy() {
            axes = normalize_axes(&items(axes_part)?, place, &resolve, "LINEAR")?;
            need_xy(&axes)?;
        } else {
            let by_category = plots.iter().any(|p| p.form != Form::Xy);
            let defaults = [
                Js::Obj(obj! { "direction" => "X", "scale" => if by_category { "CATEGORY" } else { "LINEAR" } }),
                Js::Obj(obj! { "direction" => "Y", "scale" => "LINEAR" }),
            ];
            axes = normalize_axes(&defaults, place, &resolve, "LINEAR")?;
        }
        for p in plots.iter_mut() {
            bind_plot(p, &mut axes)?;
        }
        // ECharts offsets box plots that share a base category axis, which outliers drawn at
        // the category centre would not follow; one box plot per category axis keeps them aligned.
        let boxes: Vec<&Plot> = plots.iter().filter(|p| p.kind == "BOXPLOT").collect();
        for (j, b) in boxes.iter().enumerate() {
            if let Some(other) = boxes[..j].iter().find(|o| o.base == b.base) {
                return Err(format!(
                    "{place}: plots {} and {} are both BOXPLOTs on category axis {}. Put each box plot on its own category axis, or in its own chart.",
                    q(&other.id),
                    q(&b.id),
                    q(&axes[b.base.unwrap_or(0)].id)
                ));
            }
        }
        for a in 0..axes.len() {
            if axes[a].scale == "CATEGORY" {
                settle_categories(a, &plots, &mut axes, place)?;
            }
        }
    } else if single && plots[0].kind == "HISTOGRAM" {
        let recs = axis_recs(Vec::new())?;
        axes = histogram_axes(&recs, &mut plots[0], place, &resolve)?;
    } else if heat {
        let recs = axis_recs(vec![Js::Obj(obj! { "direction" => "X" }), Js::Obj(obj! { "direction" => "Y" })])?;
        axes = normalize_axes(&recs, place, &resolve, "CATEGORY")?;
        need_xy(&axes)?;
        bind_heatmap(&mut plots[0], &mut axes)?;
    } else if fam == Family::Radar {
        let recs = axis_recs(Vec::new())?;
        if recs.is_empty() {
            return Err(format!(
                "{place}: a RADAR plot needs a RADIAL axis for its spokes. Add axes [ axis direction RADIAL categories [\"…\" \"…\" \"…\"] {{}} ] {{}}."
            ));
        }
        axes = normalize_axes(&recs, place, &resolve, "LINEAR")?;
        if let Some(flat) = axes.iter().find(|a| a.direction != "RADIAL") {
            return Err(format!(
                "{}: a RADAR chart is drawn on one RADIAL axis; it has no {} axis. Remove it.",
                flat.place, flat.direction
            ));
        }
        if axes.len() > 1 {
            return Err(format!(
                "{place}: a RADAR chart has one RADIAL axis, shared by its plots; this one has {}.",
                axes.len()
            ));
        }
        let (min, max) = radar_bounds(&axes[0], &plots)?;
        radar = Some((0, min, max));
    } else if axes_part.truthy() {
        return Err(format!("{place}: a {} has no axes. Remove `axes` from this chart.", plots[0].kind));
    }

    // Legend: shown by default for several plots, or a pie's or funnel's slices; off for
    // gauges. Selection is by name, so names shown in a legend must differ.
    let legend = parts.get("legend");
    let tooltip = parts.get("tooltip");
    if legend.truthy() {
        assert_known_attributes("legend", legend, &format!("{place} legend"), None)?;
    }
    if tooltip.truthy() {
        assert_known_attributes("tooltip", tooltip, &format!("{place} tooltip"), None)?;
    }
    let legend_rec = legend.or(Js::Obj(Obj::new()));
    let legend_show =
        legend_rec.prop("show")?.or(Js::Bool(fam != Family::Gauge && (plots.len() > 1 || sliced))).truthy();
    let legend_pos = legend_rec.get("position").or(Js::str("BOTTOM"));
    let legend_pos = match legend_pos.as_str() {
        Some(pos @ ("TOP" | "BOTTOM" | "LEFT" | "RIGHT")) => pos.to_owned(),
        _ => {
            return Err(format!(
                "{place} legend: position is TOP, BOTTOM, LEFT or RIGHT, not {}.",
                js_string(&legend_pos)
            ));
        }
    };
    if legend_show {
        if sliced {
            let p = &plots[0];
            let names = p.names.as_deref().unwrap_or_default();
            if let Some(dup) = (0..names.len()).find(|&j| names[..j].contains(&names[j])) {
                let first = names.iter().position(|n| *n == names[dup]).unwrap_or(0);
                let noun = if p.kind == "PIE" { "slice" } else { "stage" };
                return Err(format!(
                    "{}: two {noun}s are named {} (items {} and {}). Legend entries toggle {noun}s by name, so give each {noun} its own name, or hide the legend with legend show false {{}}.",
                    p.place,
                    qs(&names[dup]),
                    first + 1,
                    dup + 1
                ));
            }
        } else {
            for (i, p) in plots.iter().enumerate() {
                if let Some(other) = plots.iter().enumerate().find(|(j, o)| *j != i && strict_eq(&o.name, &p.name)) {
                    return Err(format!(
                        "{place}: plots {} and {} are both named {}. Legend entries toggle plots by name, so give each plot its own name, or hide the legend with legend show false {{}}.",
                        q(&p.id),
                        q(&other.1.id),
                        q(&p.name)
                    ));
                }
            }
        }
    }

    // Layout: title at the top, legend on its side, the plot area in what is left.
    let title = settings.get("title");
    let subtitle = settings.get("subtitle");
    let title_h = if title.is_undefined() {
        0.0
    } else if subtitle.is_undefined() {
        34.0
    } else {
        56.0
    };
    let band = |side: &str| -> f64 {
        if !legend_show || legend_pos != side {
            0.0
        } else if side == "TOP" || side == "BOTTOM" {
            30.0
        } else {
            120.0
        }
    };
    let mut option = obj! {
        "animation" => settings.get("animation").or(Js::Bool(true)),
        // Time axes in UTC, for every viewer.
        "useUTC" => true,
    };
    if let Some(palette) = &look.palette {
        option.insert("color".into(), strings(palette));
    }
    option
        .insert("backgroundColor".into(), Js::Str(look.background.clone().unwrap_or_else(|| "transparent".to_owned())));
    if !title.is_undefined() {
        let mut heading = obj! { "text" => title };
        if !subtitle.is_undefined() {
            heading.insert("subtext".into(), subtitle.clone());
        }
        heading.insert("left".into(), Js::str("center"));
        heading.insert("top".into(), Js::Num(8.0));
        option.insert("title".into(), Js::Obj(heading));
    }
    if legend_show {
        let mut l = obj! { "show" => true, "type" => "scroll" };
        let place = match legend_pos.as_str() {
            "TOP" => obj! { "top" => 8.0 + title_h, "left" => "center" },
            "BOTTOM" => obj! { "bottom" => 8.0, "left" => "center" },
            "LEFT" => obj! { "left" => 8.0, "top" => "middle", "orient" => "vertical" },
            _ => obj! { "right" => 8.0, "top" => "middle", "orient" => "vertical" },
        };
        spread(&mut l, &place);
        option.insert("legend".into(), Js::Obj(l));
    }

    let tooltip_rec = tooltip.or(Js::Obj(Obj::new()));
    let by_category = fam == Family::Cartesian && plots.iter().any(|p| p.form != Form::Xy);
    let trigger = tooltip_rec.get("trigger").or(Js::str(if by_category { "AXIS" } else { "ITEM" }));
    option.insert(
        "tooltip".into(),
        Js::Obj(
            obj! { "show" => tooltip_rec.get("show").or(Js::Bool(true)), "trigger" => text(&trigger).to_lowercase() },
        ),
    );

    let shown = |side: &str| legend_show && legend_pos == side;
    let pie_center = [
        format!("{}%", num(50.0 + if shown("LEFT") { 8.0 } else { 0.0 } - if shown("RIGHT") { 8.0 } else { 0.0 })),
        format!(
            "{}%",
            num(50.0 + if title_h != 0.0 { 6.0 } else { 0.0 } + if shown("TOP") { 4.0 } else { 0.0 }
                - if shown("BOTTOM") { 4.0 } else { 0.0 })
        ),
    ];
    let mut frame_box = obj! {
        "left" => 16.0 + band("LEFT"),
        "right" => 16.0 + band("RIGHT"),
        "top" => 16.0 + title_h + band("TOP"),
        "bottom" => 16.0 + band("BOTTOM"),
    };

    // A heatmap's colour scale is generated from its cells, on the side the legend is not on.
    if heat && let Some(cells) = plots[0].cells.as_ref().filter(|c| !c.is_empty()) {
        let vals: Vec<f64> = cells.iter().map(|c| c[2]).collect();
        let (mut min, mut max) = (js_min(&vals), js_max(&vals));
        if min == max {
            (min, max) = constant_range(min);
        }
        let side = if shown("RIGHT") { "left" } else { "right" };
        option.insert(
            "visualMap".into(),
            Js::Obj(obj! {
                "type" => "continuous",
                "dimension" => 2.0,
                "min" => min,
                "max" => max,
                "calculable" => true,
                "orient" => "vertical",
                side => 8.0,
                "top" => "middle",
            }),
        );
        let widened = frame_box.get(side).and_then(Js::as_num).unwrap_or(0.0) + 72.0;
        frame_box.insert(side.into(), Js::Num(widened));
    }

    if !axes.is_empty() && radar.is_none() {
        let mut grid = frame_box.clone();
        grid.insert("outerBoundsMode".into(), Js::str("same"));
        grid.insert("outerBoundsContain".into(), Js::str("all"));
        option.insert("grid".into(), Js::Obj(grid));
        let cell_axes = if heat {
            obj! { "boundaryGap" => true, "splitArea" => obj! { "show" => true } }
        } else {
            Obj::new()
        };
        // Prices sit far from 0, so a value axis under a candlestick fits the data rather than
        // starting at 0 (`min-value` still wins).
        let priced: Vec<usize> = plots
            .iter()
            .filter(|p| p.kind == "CANDLESTICK")
            .filter_map(|p| if p.base == p.x_axis { p.y_axis } else { p.x_axis })
            .collect();
        let fit = |a: usize| {
            if priced.contains(&a) {
                obj! { "scale" => true }
            } else {
                Obj::new()
            }
        };
        let lowered = |d: &str| -> Js {
            Js::Arr(
                (0..axes.len())
                    .filter(|&a| axes[a].direction == d)
                    .map(|a| {
                        let mut extra = Obj::new();
                        if d == "X" || heat {
                            spread(&mut extra, &cell_axes);
                        }
                        if heat && d == "Y" {
                            extra.insert("inverse".into(), Js::Bool(!axes[a].inverse.truthy()));
                        } else {
                            spread(&mut extra, &fit(a));
                        }
                        Js::Obj(lower_axis(&axes[a], extra))
                    })
                    .collect(),
            )
        };
        option.insert("xAxis".into(), lowered("X"));
        // A heatmap reads like its matrix: the first Y category is the top row.
        option.insert("yAxis".into(), lowered("Y"));
    }
    if let Some((a, min, max)) = radar {
        // One scalar range on every spoke: per-spoke scales are a documented limitation.
        let indicator = axes[a]
            .categories
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|c| Js::Obj(obj! { "name" => c, "min" => min, "max" => max }))
            .collect();
        option.insert(
            "radar".into(),
            Js::Obj(obj! { "indicator" => Js::Arr(indicator), "center" => strings(&pie_center), "radius" => "65%" }),
        );
    }
    let frame_of =
        |i: usize| Frame { pie_center: pie_center.clone(), r#box: frame_box.clone(), slot: (i, plots.len()) };
    let mut series = Vec::new();
    for (i, p) in plots.iter().enumerate() {
        let mut label = check_label(p.src.get("label"), &p.kind, &p.place)?;
        // A named scatter point is labelled with its name unless the author said otherwise.
        if label.is_none() && p.kind == "SCATTER" && p.names.is_some() {
            label = Some(obj! { "show" => true, "position" => "top", "formatter" => "{b}" });
        }
        series.extend(lower_series(p, label, &frame_of(i), &axes)?);
    }
    option.insert("series".into(), Js::Arr(series));

    let description = settings.get("description").or(Js::Str(summarize(title, name, &plots, &axes)));
    option.insert(
        "aria".into(),
        Js::Obj(obj! { "enabled" => true, "label" => obj! { "enabled" => true, "description" => &description } }),
    );

    let height = settings.get("height");
    if !height.is_undefined() && !height.as_num().is_some_and(|h| h > 0.0) {
        return Err(format!("{place}: height must be above 0 pixels, got {}.", js_string(height)));
    }
    Ok(Js::Obj(obj! {
        "id" => id,
        "name" => name,
        "option" => option,
        "view" => obj! {
            "width" => settings.get("width").or(Js::str("100%")),
            "height" => height.or(Js::Num(384.0)),
            "empty" => plots.iter().all(is_empty),
            "description" => description,
        },
    }))
}

/// `Math.min(...vals)`: NaN if any is NaN.
fn js_min(vals: &[f64]) -> f64 {
    vals.iter().fold(f64::INFINITY, |m, &v| if v.is_nan() || m.is_nan() { f64::NAN } else { m.min(v) })
}

fn js_max(vals: &[f64]) -> f64 {
    vals.iter().fold(f64::NEG_INFINITY, |m, &v| if v.is_nan() || m.is_nan() { f64::NAN } else { m.max(v) })
}
