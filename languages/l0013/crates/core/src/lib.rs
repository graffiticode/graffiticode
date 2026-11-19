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
pub mod faults;

use faults::{Armed, CaptureFault, CaptureFaults, STALE_GENERATION};

/// The protected registry's version (`packages/common/src/protected-registry.ts`), kept equal to
/// it by `scripts/check-registry-version.js`. L0013 registers `snap` from version 9 (C5,
/// `docs/c5-l0013-commands-plan.md`), and reports this version in its preflight manifests
/// (C5a slice 6).
pub const REGISTRY_VERSION: u32 = 9;

/// `snap`'s registered names (the registry's `PROTECTED_FUNCTIONS["0013"].snap`).
pub const SNAP: &str = "snap";
pub const SNAP_OP: &str = "gcs.put-thumbnail";
/// The most captures one `snap` site makes in one command stage (its intent's bound).
pub const MAX_SNAPS_PER_SITE: u32 = 16;

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use graffiticode_l0000::{
    Ast, Dialect, Evaluator, Intent, IntentScope, Key, Lexicon, Node, NodeId, Op, ProtectedCall, ProtectedFunction,
    ProtectedKind, Record, Value,
};
use serde_json::json;

/// A Policy render grant (C5), as a command's capture renders a private item under it.
pub use graffiticode_l0000::RenderGrant;

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
    /// Under a command (C5): Policy's render grant for a private item's capture, in place of any
    /// user token. Never sent with one.
    pub render_grant: Option<RenderGrant>,
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

    /// Renders and crops, and stores nothing: the PNG a command stages (C5 decision 9), which
    /// Broker publishes. A camera that can't is refused under a command.
    async fn render(&self, _request: SnapRequest) -> Result<Vec<u8>, CameraError> {
        Err("this camera can't render without storing the capture".into())
    }

    /// What the camera reports about its configuration (where captures go), for `/egress`.
    fn status(&self) -> Option<serde_json::Value> {
        None
    }
}

#[derive(Clone)]
pub struct L0013 {
    camera: Arc<dyn Camera>,
    protected: Vec<(String, ProtectedFunction)>,
    /// The C5d drive's capture fault points ([`faults`]); none outside a drive.
    faults: Option<CaptureFaults>,
}

impl L0013 {
    pub fn new(camera: impl Camera + 'static) -> Self {
        Self {
            camera: Arc::new(camera),
            protected: vec![("SNAP".to_owned(), ProtectedFunction::new(SNAP, ProtectedKind::Write))],
            faults: None,
        }
    }

    /// With the drive's capture faults (`L0013_CAPTURE_FAULTS`, read by the server).
    pub fn with_capture_faults(mut self, faults: CaptureFaults) -> Self {
        self.faults = Some(faults);
        self
    }
}

/// A `snap` site: where it is in the source (stable across normalization), or its node.
pub fn snap_site(ast: &Ast, id: NodeId) -> String {
    ast.span(id).map_or_else(|| format!("n{id}"), |span| span.from.to_string())
}

/// A `snap` site's intent id: `snap:<site>` (policy accepts `[A-Za-z0-9_:.-]`).
pub fn snap_intent_id(site: &str) -> String {
    format!("snap:{site}")
}

/// The item a `snap` names as a literal, if it does: the outermost `item` modifier of its
/// options, as evaluation lets the outermost win. `None` when that modifier's value is computed,
/// or there is none: the item then arrives as data.
pub fn literal_item(ast: &Ast, snap: NodeId) -> Option<String> {
    let mut at = ast.get(snap)?.elts().first().copied();
    while let Some(id) = at {
        let Node::Form { op, elts } = ast.get(id)? else { return None };
        match op.tag() {
            "ITEM" => {
                return match elts.first().and_then(|&value| ast.get(value)) {
                    Some(Node::Str(item)) if !item.is_empty() => Some(item.clone()),
                    _ => None,
                };
            }
            "VIEWPORT" | "SLICE" | "ZOOM" | "CROP" | "WIDTH" | "HEIGHT" => at = elts.get(1).copied(),
            _ => return None,
        }
    }
    None
}

/// The occurrences one site has made in this stage, by site (a command's expansion keys).
#[derive(Default)]
struct SiteCounts(std::collections::HashMap<String, u32>);

#[async_trait]
impl Dialect for L0013 {
    fn lang_id(&self) -> &str {
        "0013"
    }

    /// Where captures are stored (`thumbnailBucket`, null when none is configured), so an
    /// evidence run can check it is the isolated bucket before its first capture.
    fn status(&self) -> Option<serde_json::Value> {
        self.camera.status()
    }

    /// `snap` is a protected write (C5): Broker publishes the capture as itself, on the item's
    /// scope. Admitted only as a command: any other compile admits nothing, asks policy nothing
    /// whatever connection was sent, and uploads directly as before.
    fn protected_functions(&self) -> &[(String, ProtectedFunction)] {
        &self.protected
    }

    fn admits_outside_commands(&self) -> bool {
        false
    }

    fn registry_version(&self) -> Option<u32> {
        Some(REGISTRY_VERSION)
    }

    /// One runtime-expanded intent per `snap` site, on its item: static when the program names
    /// it as a literal (authorized at admission), bound otherwise (authorized at reservation).
    fn intents(&self, ast: &Ast) -> Vec<Intent> {
        ast.nodes()
            .filter_map(|(id, node)| match node {
                Node::Form { op, .. } if op.tag() == "SNAP" => Some(
                    Intent::expanding(snap_intent_id(&snap_site(ast, id)), SNAP, SNAP_OP, MAX_SNAPS_PER_SITE)
                        .with_scope(IntentScope::Item(literal_item(ast, id))),
                ),
                _ => None,
            })
            .collect()
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
        // A snapshot is always of the item's own task, resolved (and access-checked) from the
        // item. A program can't name another task or language to render under the item's path.
        if ["task", "lang"].into_iter().any(|name| options.get(&Key::tag(name)).is_some()) {
            cx.report(id, "snap: `task` and `lang` are not accepted — snap renders the item's own task.");
            return Value::Null;
        }
        let request = SnapRequest {
            item: item.display(),
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
            render_grant: None,
        };
        if cx.exec().is_command() {
            return self.capture(cx, id, request).await;
        }
        match self.camera.snap(request).await {
            Ok(Snapshot { url, item }) => snapshot_value(url, item),
            Err(err) => {
                cx.report(id, format!("snap failed: {err}"));
                Value::Null
            }
        }
    }

    /// A command's snap (C5 decision 9): the occurrence reserved (the item's next capture
    /// sequence), rendered only when nothing is staged for it yet, staged, then published by
    /// Broker with exactly `{ item, sha256, captureSequence }` as staged. Its value is the
    /// publication's `{ url, item }`.
    async fn capture(&self, cx: &mut Evaluator<'_>, id: NodeId, request: SnapRequest) -> Value {
        let site = snap_site(cx.ast(), id);
        let n = {
            let counts = &mut cx.exec().state::<SiteCounts>().0;
            let n = counts.entry(site.clone()).or_default();
            *n += 1;
            *n - 1
        };
        let item = request.item.clone();
        // A drive's fault, armed only for its target command at owner generation 1 (C5d).
        let armed = self.faults.as_ref().and_then(|faults| faults.armed(cx.exec().command_claims().as_ref()));
        let outcome: Result<serde_json::Value, String> = async {
            let occurrence = cx.exec().expand(&snap_intent_id(&site), &format!("{site}#{n}")).map_err(|e| e.to_string())?;
            let reserved = cx.exec().reserve_capture(&occurrence, &item).await.map_err(|e| e.to_string())?;
            if let Some(armed) = armed.as_ref().filter(|a| a.fault == CaptureFault::ExitAfterReserve) {
                return Err(exit(armed));
            }
            let sha256 = match reserved.staged {
                Some(staged) => staged.sha256,
                None => {
                    // A command carries no user token: a private item renders under the grant
                    // Policy gave this reservation, a public one under nothing.
                    let request = SnapRequest { token: None, render_grant: reserved.render_grant.clone(), ..request };
                    let png = self.camera.render(request).await.map_err(|e| e.to_string())?;
                    if let Some(armed) = armed.as_ref().filter(|a| a.fault == CaptureFault::StallBeforeStage) {
                        stall(cx, armed, &occurrence, &item).await;
                    }
                    cx.exec().stage_capture(&occurrence, &png).await.map_err(|e| e.to_string())?.sha256
                }
            };
            // After staging, whether this run staged or found it staged: generation 1 never
            // gets past here.
            if let Some(armed) = armed.as_ref().filter(|a| a.fault == CaptureFault::ExitAfterStage) {
                return Err(exit(armed));
            }
            let call = ProtectedCall {
                function: SNAP.to_owned(),
                op: SNAP_OP.to_owned(),
                payload: json!({ "item": reserved.item, "sha256": sha256, "captureSequence": reserved.capture_sequence }),
                occurrence_id: occurrence,
            };
            let outcome = cx.exec().invoke(&call).await.map_err(|e| e.to_string())?;
            if outcome["status"] != "succeeded" {
                let reason = outcome["reason"].as_str().unwrap_or("not published");
                return Err(format!("the capture wasn't published ({reason})"));
            }
            Ok(outcome["result"].clone())
        }
        .await;
        match outcome {
            Ok(result) => match (result["url"].as_str(), result["item"].as_str()) {
                (Some(url), Some(item)) => snapshot_value(url.to_owned(), item.to_owned()),
                _ => {
                    cx.report(id, "snap failed: the publication returned no url");
                    Value::Null
                }
            },
            Err(err) => {
                cx.report(id, format!("snap failed: {err}"));
                Value::Null
            }
        }
    }
}

/// An exit fault: the process ends (in a test, the capture stops here with an error).
fn exit(armed: &Armed) -> String {
    armed.exit();
    format!("capture fault {} exited", armed.fault.as_str())
}

/// `stall-before-stage`: holds the request open until the takeover is observed. Every probe
/// interval it repeats the reservation of its own occurrence under its generation-1 session.
/// Before a takeover that answers the recorded reservation; after one Policy refuses it as a
/// stale generation, the signal to continue (to its own staging, which Policy refuses too).
/// Any other answer keeps it waiting, up to the bound, where it logs `no-takeover` and
/// continues.
///
/// The bound is one monotonic deadline over the sleeps and each probe's own wait, so a slow or
/// hanging Policy request can't hold the stall past it: a probe still unanswered at the deadline
/// is dropped.
async fn stall(cx: &mut Evaluator<'_>, armed: &Armed, occurrence: &str, item: &str) {
    armed.warn("stalling until the takeover");
    let deadline = armed.deadline();
    while !armed.remaining(deadline).is_zero() {
        armed.sleep_until_probe(deadline).await;
        if armed.remaining(deadline).is_zero() {
            break;
        }
        match armed.before(deadline, cx.exec().reserve_capture(occurrence, item)).await {
            Some(Err(error)) if error.reason() == Some(STALE_GENERATION) => {
                armed.warn("takeover observed");
                return;
            }
            Some(Ok(_)) => {}
            Some(Err(error)) => armed.warn(&format!("probe refused ({error}), still waiting")),
            None => {
                armed.warn("probe unanswered at the bound");
                break;
            }
        }
    }
    armed.warn("no-takeover");
}

fn snapshot_value(url: String, item: String) -> Value {
    Value::Record([(Key::tag("url"), Value::Str(url)), (Key::tag("item"), Value::Str(item))].into_iter().collect())
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
