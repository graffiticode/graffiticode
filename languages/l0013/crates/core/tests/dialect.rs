// SPDX-License-Identifier: MIT

//! `snap`, with a camera that records what it was asked for instead of photographing anything.
//! The programs are hand-built ASTs: the conformance fixture deliberately holds no program that
//! reaches a camera.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use graffiticode_l0000::{Compiler, Identity, Lexicon};
use graffiticode_l0013::{Camera, CameraError, Clip, L0013, Size, SnapRequest, Snapshot, lexicon};
use serde_json::{Value as Json, json};

#[derive(Clone, Default)]
struct FakeCamera {
    asked: Arc<Mutex<Vec<SnapRequest>>>,
    broken: bool,
}

#[async_trait]
impl Camera for FakeCamera {
    async fn snap(&self, request: SnapRequest) -> Result<Snapshot, CameraError> {
        self.asked.lock().unwrap().push(request.clone());
        if self.broken {
            return Err("could not resolve item abc123: HTTP 404".into());
        }
        Ok(Snapshot { url: format!("https://storage.example/thumbnails/{}.png?v=1", request.item), item: request.item })
    }
}

/// `snap zoom 0.5 slice "4:1" width 240 crop {x: 10 width: 800} viewport {width: 800 height: 600} item "abc123" {}..`
fn full_program() -> Json {
    json!({
        "1": { "tag": "RECORD", "elts": [] },
        "2": { "tag": "STR", "elts": ["abc123"] }, "3": { "tag": "ITEM", "elts": [2, 1] },
        "4": { "tag": "TAG", "elts": ["width"] }, "5": { "tag": "NUM", "elts": ["800"] },
        "6": { "tag": "BINDING", "elts": [4, 5] },
        "7": { "tag": "TAG", "elts": ["height"] }, "8": { "tag": "NUM", "elts": ["600"] },
        "9": { "tag": "BINDING", "elts": [7, 8] }, "10": { "tag": "RECORD", "elts": [6, 9] },
        "11": { "tag": "VIEWPORT", "elts": [10, 3] },
        "12": { "tag": "TAG", "elts": ["x"] }, "13": { "tag": "NUM", "elts": ["10"] },
        "14": { "tag": "BINDING", "elts": [12, 13] }, "15": { "tag": "RECORD", "elts": [14, 6] },
        "16": { "tag": "CROP", "elts": [15, 11] },
        "17": { "tag": "NUM", "elts": ["240"] }, "18": { "tag": "WIDTH", "elts": [17, 16] },
        "19": { "tag": "STR", "elts": ["4:1"] }, "20": { "tag": "SLICE", "elts": [19, 18] },
        "21": { "tag": "NUM", "elts": ["0.5"] }, "22": { "tag": "ZOOM", "elts": [21, 20] },
        "23": { "tag": "SNAP", "elts": [22], "coord": { "from": 0, "to": 4 } },
        "24": { "tag": "EXPRS", "elts": [23] }, "25": { "tag": "PROG", "elts": [24] }, "root": 25,
    })
}

/// `snap item "abc123" {}..`
fn minimal_program() -> Json {
    json!({
        "1": { "tag": "RECORD", "elts": [] },
        "2": { "tag": "STR", "elts": ["abc123"] }, "3": { "tag": "ITEM", "elts": [2, 1] },
        "4": { "tag": "SNAP", "elts": [3], "coord": { "from": 0, "to": 4 } },
        "5": { "tag": "EXPRS", "elts": [4] }, "6": { "tag": "PROG", "elts": [5] }, "root": 6,
    })
}

#[test]
fn the_lexicon_is_the_base_language_and_the_screenshot_words() {
    assert_eq!(lexicon().len(), Lexicon::base().len() + 8);
    for (word, tag) in [("snap", "SNAP"), ("item", "ITEM"), ("viewport", "VIEWPORT"), ("slice", "SLICE")] {
        assert_eq!(lexicon().get(word).unwrap().name, tag);
    }
    for word in ["zoom", "crop", "width", "height"] {
        assert_eq!(lexicon().get(word).unwrap().arity, 2);
    }
}

#[tokio::test]
async fn snap_hands_the_camera_everything_the_options_say() {
    let camera = FakeCamera::default();
    let compiled = Compiler::new(L0013::new(camera.clone()))
        .compile(&full_program(), &json!({}), &json!({}), Identity::default())
        .await;
    assert_eq!(
        compiled.result.unwrap().to_json(),
        Some(json!({ "url": "https://storage.example/thumbnails/abc123.png?v=1", "item": "abc123" }))
    );
    assert_eq!(
        *camera.asked.lock().unwrap(),
        [SnapRequest {
            item: "abc123".into(),
            viewport: Size { width: Some(800.0), height: Some(600.0) },
            slice: Some("4:1".into()),
            zoom: Some(0.5),
            crop: Clip { x: Some(10.0), y: None, width: Some(800.0), height: None },
            width: Some(240.0),
            ..SnapRequest::default()
        }]
    );
}

#[tokio::test]
async fn options_left_out_are_left_to_the_camera() {
    let camera = FakeCamera::default();
    let compiled = Compiler::new(L0013::new(camera.clone()))
        .compile(&minimal_program(), &json!({}), &json!({}), Identity::default())
        .await;
    assert!(compiled.result.is_ok());
    let asked = camera.asked.lock().unwrap();
    assert_eq!(*asked, [SnapRequest { item: "abc123".into(), ..SnapRequest::default() }]);
    assert!(!asked[0].crop.is_set());
}

#[tokio::test]
async fn only_a_verified_token_reaches_the_camera() {
    let ask = async |identity: Identity| {
        let camera = FakeCamera::default();
        Compiler::new(L0013::new(camera.clone())).compile(&minimal_program(), &json!({}), &json!({}), identity).await;
        camera.asked.lock().unwrap()[0].token.clone()
    };
    // The server sets `user_token` only beside a uid it verified.
    let verified = Identity { uid: Some("u1".into()), user_token: Some("owner-token".into()), ..Identity::default() };
    assert_eq!(ask(verified).await.as_deref(), Some("owner-token"));
    assert_eq!(ask(Identity::default()).await, None);
}

#[tokio::test]
async fn a_program_cannot_read_the_token_through_its_config() {
    // `get-var "config"`: the TypeScript server put the caller's token into config; here it
    // travels in the invocation's identity, which no program can read.
    let program = json!({
        "1": { "tag": "STR", "elts": ["config"] }, "2": { "tag": "GET_VAR", "elts": [1] },
        "3": { "tag": "EXPRS", "elts": [2] }, "4": { "tag": "PROG", "elts": [3] }, "root": 4,
    });
    let identity = Identity { uid: Some("u1".into()), user_token: Some("owner-token".into()), ..Identity::default() };
    let compiled = Compiler::new(L0013::new(FakeCamera::default()))
        .compile(&program, &json!({}), &json!({ "theme": "dark" }), identity)
        .await;
    assert_eq!(compiled.result.unwrap().to_json(), Some(json!({ "theme": "dark" })));
}

#[tokio::test]
async fn a_failed_photograph_is_a_compile_error_at_the_snap() {
    let camera = FakeCamera { broken: true, ..FakeCamera::default() };
    let errors = Compiler::new(L0013::new(camera))
        .compile(&minimal_program(), &json!({}), &json!({}), Identity::default())
        .await
        .result
        .unwrap_err();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].message, "snap failed: could not resolve item abc123: HTTP 404");
    assert_eq!((errors[0].from, errors[0].to), (0, 4));
}
