// SPDX-License-Identifier: MIT

//! The conformance fixtures' fetcher, shared by the tests: `https://example.org/<file>` and
//! `https://l0185.graffiticode.org/data/<file>` read `packages/core/data/<file>` (or
//! `fixtures/`), and `https://example.org/t/<name>` the bodies in `conformance/fetches.json`.
//! Nothing is fetched from the network.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use graffiticode_l0185::{FetchResult, Fetcher};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(untagged)]
enum Synthetic {
    Body {
        text: String,
        #[serde(rename = "contentType")]
        content_type: String,
    },
    Error {
        error: String,
    },
}

/// The TypeScript harness's fetcher, recording what it was asked for.
#[derive(Clone, Default)]
pub struct Fixtures {
    synthetic: Arc<HashMap<String, Synthetic>>,
    pub fetched: Arc<Mutex<Vec<String>>>,
}

impl Fixtures {
    pub fn new() -> Self {
        Self {
            synthetic: Arc::new(serde_json::from_str(include_str!("../conformance/fetches.json")).unwrap()),
            fetched: Arc::default(),
        }
    }
}

#[async_trait]
impl Fetcher for Fixtures {
    async fn fetch(&self, url: &str) -> Result<FetchResult, String> {
        self.fetched.lock().unwrap().push(url.to_owned());
        let missing =
            || Err(format!("fetch: fetching {} failed: the server answered 404.", serde_json::to_string(url).unwrap()));
        if let Some(name) = url.strip_prefix("https://example.org/t/") {
            return match self.synthetic.get(url) {
                Some(Synthetic::Body { text, content_type }) => {
                    Ok(FetchResult { text: text.clone(), content_type: content_type.clone(), fetched_at: None })
                }
                Some(Synthetic::Error { error }) => Err(error.clone()),
                None => {
                    let _ = name;
                    missing()
                }
            };
        }
        let Some(file) = url
            .strip_prefix("https://example.org/")
            .or_else(|| url.strip_prefix("https://l0185.graffiticode.org/data/"))
        else {
            return missing();
        };
        let core = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/core");
        let data = core.join("data").join(file);
        let path = if data.is_file() { data } else { core.join("fixtures").join(file) };
        let Ok(text) = std::fs::read_to_string(&path) else { return missing() };
        let content_type = if file.ends_with(".csv") {
            "text/csv"
        } else if file.ends_with(".html") {
            "text/html"
        } else {
            "application/json"
        };
        Ok(FetchResult { text, content_type: content_type.to_owned(), fetched_at: None })
    }
}
