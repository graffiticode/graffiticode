// SPDX-License-Identifier: MIT

//! Where fetched data comes from, and how a body becomes data (`packages/core/src/source.ts`).
//!
//! The core never touches the network itself: a [`Fetcher`] is handed to the dialect. The
//! language server's is the guarded HTTPS fetcher (`fetch.rs`); tests hand it fixtures.

use async_trait::async_trait;

use crate::js::{Js, quote};

/// A fetched body and its content type.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FetchResult {
    pub text: String,
    pub content_type: String,
}

/// Fetches a URL for `fetch`. An error is the compile error, word for word.
#[async_trait]
pub trait Fetcher: Send + Sync {
    async fn fetch(&self, url: &str) -> Result<FetchResult, String>;
}

/// Turn a fetched body into data: by `parse`, else the content type, else a sniff.
pub fn parse_body(url: &str, body: &FetchResult, format: Option<&str>) -> Result<Js, String> {
    let ct = body.content_type.to_lowercase();
    let text = body.text.strip_prefix('\u{feff}').unwrap_or(&body.text);
    let start = text.trim_start_matches(crate::js::is_space);
    let html = ct.contains("text/html") || {
        let head: String = start.chars().take(9).collect::<String>().to_lowercase();
        head.starts_with("<!doctype") || head.starts_with("<html")
    };
    if html && format != Some("CSV") {
        return Err(format!("fetch: {} returned an HTML page, not JSON or CSV.", quote(url)));
    }
    let kind = format.unwrap_or(if ct.contains("json") {
        "JSON"
    } else if ct.contains("csv") {
        "CSV"
    } else if start.starts_with('[') || start.starts_with('{') {
        "JSON"
    } else {
        "CSV"
    });
    if kind == "JSON" {
        return Js::parse_json(text).ok_or_else(|| {
            format!("fetch: {} is not valid JSON. If it is CSV, write parse CSV to its right.", quote(url))
        });
    }
    let parsed = crate::csv::parse(text);
    if parsed.data.is_empty()
        && let Some(first) = parsed.errors.first()
    {
        return Err(format!("fetch: {} could not be read as CSV: {first}.", quote(url)));
    }
    Ok(Js::Arr(parsed.data))
}
