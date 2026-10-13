// SPDX-License-Identifier: MIT

//! L0013 — photographs the rendered form view of another Graffiticode item. It inherits the
//! whole base language and adds a screenshot vocabulary.
//!
//! A program is `snap <options>..`, where the options are built by chaining modifiers onto a
//! record: `snap width 240 item "abc123" {}..`. Each modifier returns the record with one more
//! field. `snap` renders the item's form, crops it, uploads a PNG and evaluates to
//! `{ url, item }`.
//!
//! The dialect itself is pure: it assembles a [`SnapRequest`] and hands it to a [`Camera`].
//! Rendering, cropping and uploading live behind that trait (the `l0013-capture` crate), so
//! the language can be compiled and tested without a browser. Deciding *where* to crop is a
//! pure function of the pixels and lives here, in [`crop`].

pub mod crop;

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use graffiticode_l0000::{Dialect, Evaluator, Key, Lexicon, NodeId, Op, Record, Value};

/// The words L0013 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0013")).expect("L0013 shadows no base word")
});

/// L0013's vocabulary: the base lexicon and the screenshot words.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// A width and a height, either of which may be left to a default.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Size {
    pub width: Option<f64>,
    pub height: Option<f64>,
}

/// An explicit clip rectangle in the form's own (CSS) pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Clip {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

impl Clip {
    pub fn is_set(&self) -> bool {
        [self.x, self.y, self.width, self.height].iter().any(Option::is_some)
    }
}

/// What one `snap` asks for.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SnapRequest {
    /// The item whose form view is photographed. Its task and language are resolved from it.
    pub item: String,
    /// An explicit task to render instead of resolving one from the item.
    pub task: Option<String>,
    pub lang: Option<String>,
    /// The browser window the form lays out into.
    pub viewport: Size,
    /// `"W:H"`: crop the densest band of that aspect.
    pub slice: Option<String>,
    /// 0 frames all the ink of a slice, 1 its densest region.
    pub zoom: Option<f64>,
    /// A manual override of the content-aware crop.
    pub crop: Clip,
    /// The largest output width and height in pixels; together, a box to fit inside.
    pub width: Option<f64>,
    pub height: Option<f64>,
    /// The caller's verified access token, for rendering a form that is not public.
    pub token: Option<String>,
}

/// A photograph that has been taken and stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    /// The public URL of the uploaded PNG, which is what the form view renders.
    pub url: String,
    /// The item the URL was derived from.
    pub item: String,
}

pub type CameraError = Box<dyn std::error::Error + Send + Sync>;

/// Takes the photograph: renders, crops, stores.
#[async_trait]
pub trait Camera: Send + Sync {
    async fn snap(&self, request: SnapRequest) -> Result<Snapshot, CameraError>;
}

#[derive(Clone)]
pub struct L0013 {
    camera: Arc<dyn Camera>,
}

impl L0013 {
    pub fn new(camera: impl Camera + 'static) -> Self {
        Self { camera: Arc::new(camera) }
    }
}

#[async_trait]
impl Dialect for L0013 {
    fn lang_id(&self) -> &str {
        "0013"
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let field = match op.tag() {
            "SNAP" => return Some(self.snap(cx, id, elts).await),
            "ITEM" => "item",
            "VIEWPORT" => "viewport",
            "SLICE" => "slice",
            "ZOOM" => "zoom",
            "CROP" => "crop",
            "WIDTH" => "width",
            "HEIGHT" => "height",
            _ => return None,
        };
        // A modifier is `<word> <value> <options>`: the options, with one more field.
        let value = cx.eval_arg(id, elts, 0).await;
        let mut options = fields(cx.eval_arg(id, elts, 1).await);
        options.insert(Key::tag(field), value);
        Some(Value::Record(options))
    }
}

impl L0013 {
    async fn snap(&self, cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
        let options = fields(cx.eval_arg(id, elts, 0).await);
        let get = |name: &str| options.get(&Key::tag(name)).filter(|value| value.is_truthy());
        let Some(item) = get("item") else {
            cx.report(id, "snap: missing required `item` — use `snap item \"<id>\" {}..`.");
            return Value::Null;
        };
        let text = |name: &str| get(name).map(Value::display);
        let request = SnapRequest {
            item: item.display(),
            task: text("task"),
            lang: text("lang"),
            viewport: size(options.get(&Key::tag("viewport"))),
            slice: match options.get(&Key::tag("slice")) {
                Some(Value::Str(slice)) => Some(slice.clone()),
                _ => None,
            },
            zoom: options.get(&Key::tag("zoom")).and_then(number),
            crop: clip(options.get(&Key::tag("crop"))),
            width: options.get(&Key::tag("width")).and_then(number),
            height: options.get(&Key::tag("height")).and_then(number),
            // Only a token the server verified reaches the camera.
            token: cx.exec().user_token().map(str::to_owned),
        };
        match self.camera.snap(request).await {
            Ok(Snapshot { url, item }) => Value::Record(
                [(Key::tag("url"), Value::Str(url)), (Key::tag("item"), Value::Str(item))].into_iter().collect(),
            ),
            Err(err) => {
                cx.report(id, format!("snap failed: {err}"));
                Value::Null
            }
        }
    }
}

/// The options a value carries: a record's fields by name, whatever kind of key they were
/// written with. Anything else carries none.
fn fields(value: Value) -> Record {
    match value {
        Value::Record(record) => {
            record.into_iter().map(|(key, value)| (Key::tag(key.name().into_owned()), value)).collect()
        }
        _ => Record::new(),
    }
}

/// A number, or a string written as one.
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Num(n) => Some(n.to_f64()),
        Value::Str(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|n: &f64| !n.is_nan())
}

fn dimension(record: Option<&Value>, name: &str) -> Option<f64> {
    match record {
        Some(Value::Record(record)) => record.get(&Key::tag(name)).and_then(number),
        _ => None,
    }
}

fn size(value: Option<&Value>) -> Size {
    Size { width: dimension(value, "width"), height: dimension(value, "height") }
}

fn clip(value: Option<&Value>) -> Clip {
    Clip {
        x: dimension(value, "x"),
        y: dimension(value, "y"),
        width: dimension(value, "width"),
        height: dimension(value, "height"),
    }
}
