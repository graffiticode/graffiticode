// SPDX-License-Identifier: MIT

//! Schemas for the `data use "<lang>"` form: `use` resolves the upstream language's published
//! `schema.json`, and `data` checks the chained upstream value against it before merging.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value as Json;

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
#[error("{0}")]
pub struct SchemaError(pub String);

/// A language's published JSON Schema (draft-07 or 2020-12, chosen by its `$schema`), compiled
/// once.
pub struct LanguageSchema {
    title: String,
    validator: jsonschema::Validator,
}

impl LanguageSchema {
    pub fn new(schema: &Json) -> Result<Self, SchemaError> {
        let title = ["title", "$id"]
            .iter()
            .find_map(|key| schema.get(key).and_then(Json::as_str))
            .unwrap_or("schema")
            .to_owned();
        let validator =
            jsonschema::validator_for(schema).map_err(|err| SchemaError(format!("invalid schema: {err}")))?;
        Ok(Self { title, validator })
    }

    /// One message per violation; empty when the value conforms.
    pub fn validate(&self, value: &Json) -> Vec<String> {
        self.validator
            .iter_errors(value)
            .map(|err| {
                let path = err.instance_path().as_str();
                let path = if path.is_empty() { "(root)" } else { path };
                format!("upstream data does not match {}: {path} {err}", self.title)
            })
            .collect()
    }
}

impl std::fmt::Debug for LanguageSchema {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LanguageSchema").field("title", &self.title).finish_non_exhaustive()
    }
}

/// Where `use` finds a language's schema. `lang` is the bare id, e.g. `"0166"`.
#[async_trait]
pub trait SchemaSource: Send + Sync {
    async fn schema(&self, lang: &str) -> Result<Arc<LanguageSchema>, SchemaError>;
}

/// A source with nothing in it: every `use` fails.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoSchemas;

#[async_trait]
impl SchemaSource for NoSchemas {
    async fn schema(&self, _lang: &str) -> Result<Arc<LanguageSchema>, SchemaError> {
        Err(SchemaError("no schema source is configured".to_owned()))
    }
}

#[cfg(feature = "http")]
pub use http::HttpSchemas;

#[cfg(feature = "http")]
mod http {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use super::*;

    const TTL: Duration = Duration::from_secs(60 * 60);
    const DEFAULT_API_URL: &str = "https://api.graffiticode.org";

    /// Fetches `L<lang>/schema.json` from the Graffiticode API and keeps each for an hour.
    /// Failures are not cached.
    pub struct HttpSchemas {
        client: reqwest::Client,
        api_url: String,
        cache: Mutex<HashMap<String, (Instant, Arc<LanguageSchema>)>>,
    }

    impl HttpSchemas {
        pub fn new(client: reqwest::Client, api_url: impl Into<String>) -> Self {
            Self { client, api_url: api_url.into().trim_end_matches('/').to_owned(), cache: Mutex::default() }
        }

        /// The API named by `GRAFFITICODE_API_URL`, or the public one.
        pub fn from_env(client: reqwest::Client) -> Self {
            let api_url = std::env::var("GRAFFITICODE_API_URL").ok().filter(|url| !url.is_empty());
            Self::new(client, api_url.unwrap_or_else(|| DEFAULT_API_URL.to_owned()))
        }

        async fn fetch(&self, lang: &str) -> Result<LanguageSchema, SchemaError> {
            let url = format!("{}/L{lang}/schema.json", self.api_url);
            let response = self
                .client
                .get(&url)
                .send()
                .await
                .map_err(|err| SchemaError(format!("network error fetching {url}: {err}")))?;
            if !response.status().is_success() {
                return Err(SchemaError(format!("HTTP {} from {url}", response.status().as_u16())));
            }
            let schema: Json =
                response.json().await.map_err(|err| SchemaError(format!("invalid JSON at {url}: {err}")))?;
            LanguageSchema::new(&schema)
        }
    }

    #[async_trait]
    impl SchemaSource for HttpSchemas {
        async fn schema(&self, lang: &str) -> Result<Arc<LanguageSchema>, SchemaError> {
            if let Some((fetched, schema)) = self.cache.lock().unwrap().get(lang)
                && fetched.elapsed() < TTL
            {
                return Ok(Arc::clone(schema));
            }
            let schema = Arc::new(self.fetch(lang).await?);
            self.cache.lock().unwrap().insert(lang.to_owned(), (Instant::now(), Arc::clone(&schema)));
            Ok(schema)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reports_each_violation_with_its_path() {
        let schema = LanguageSchema::new(&json!({
            "title": "L0166",
            "type": "object",
            "properties": { "x": { "type": "number" }, "rows": { "type": "array", "items": { "type": "string" } } },
            "required": ["x"],
        }))
        .unwrap();
        assert!(schema.validate(&json!({ "x": 1, "rows": ["a"] })).is_empty());

        let errors = schema.validate(&json!({ "rows": ["a", 2] }));
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert!(errors.iter().all(|e| e.starts_with("upstream data does not match L0166: ")));
        assert!(errors.iter().any(|e| e.contains("(root)") && e.contains("\"x\"")), "{errors:?}");
        assert!(errors.iter().any(|e| e.contains("/rows/1")), "{errors:?}");
    }

    #[test]
    fn understands_draft_2020_12() {
        let schema = LanguageSchema::new(&json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://example.test/tuple",
            "type": "array",
            "prefixItems": [{ "type": "number" }, { "type": "string" }],
        }))
        .unwrap();
        assert!(schema.validate(&json!([1, "a"])).is_empty());
        let errors = schema.validate(&json!(["a", 1]));
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert!(errors[0].starts_with("upstream data does not match https://example.test/tuple: /0 "));
    }

    #[test]
    fn rejects_a_schema_that_is_not_one() {
        assert!(LanguageSchema::new(&json!({ "type": 12 })).is_err());
    }
}
