// SPDX-License-Identifier: MIT

//! TransLaTeX for L0014, by way of Node.
//!
//! The translator is a JavaScript library with its own LaTeX parser. It is not rewritten here:
//! `tools/translatex-worker.mjs` runs it, one short-lived process per request, speaking JSON
//! over stdin and stdout. Only a program with a `tests` corpus or a `translate` ever starts
//! one; assembling a rule set needs no translator.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use graffiticode_l0014::{Translation, Translator, TranslatorError};
use serde::Deserialize;
use serde_json::{Value as Json, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// How long one request may take. A corpus is tens of cases and takes well under a second.
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub struct NodeTranslator {
    /// The Node executable.
    pub node: PathBuf,
    /// `translatex-worker.mjs`, somewhere `@graffiticode/translatex` resolves from.
    pub script: PathBuf,
}

impl NodeTranslator {
    /// `NODE_BIN` (default `node`) and `TRANSLATEX_WORKER` (default
    /// `tools/translatex-worker.mjs`, relative to the working directory).
    pub fn from_env() -> Self {
        let var = |name: &str, default: &str| {
            std::env::var(name).ok().filter(|value| !value.is_empty()).unwrap_or_else(|| default.to_owned())
        };
        Self {
            node: var("NODE_BIN", "node").into(),
            script: var("TRANSLATEX_WORKER", "tools/translatex-worker.mjs").into(),
        }
    }

    async fn run(&self, request: &Json) -> Result<Vec<u8>, TranslatorError> {
        let failed = |what: String| TranslatorError(format!("could not run TransLaTeX: {what}"));
        let mut worker = Command::new(&self.node)
            .arg(&self.script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| failed(format!("{} did not start ({err})", self.node.display())))?;
        let mut stdin = worker.stdin.take().expect("stdin was piped");
        let input = request.to_string();
        // Written while the output is read, so a large request cannot fill the pipe and stall.
        let write = async move {
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.shutdown().await;
        };
        let (_, output) = tokio::join!(write, tokio::time::timeout(TIMEOUT, worker.wait_with_output()));
        let output = output
            .map_err(|_| failed(format!("no answer within {} seconds", TIMEOUT.as_secs())))?
            .map_err(|err| failed(err.to_string()))?;
        if !output.status.success() {
            let complaint = String::from_utf8_lossy(&output.stderr);
            let complaint = complaint.lines().find(|line| !line.trim().is_empty()).unwrap_or("no message");
            return Err(failed(format!("the worker failed ({}): {complaint}", output.status)));
        }
        Ok(output.stdout)
    }
}

#[derive(Deserialize)]
struct Answer {
    value: Json,
    errors: Vec<String>,
}

#[async_trait]
impl Translator for NodeTranslator {
    async fn translate(&self, rules: &Json, sources: &[String]) -> Result<Vec<Translation>, TranslatorError> {
        let answer = self.run(&json!({ "rules": rules, "sources": sources })).await?;
        let answers: Vec<Answer> = serde_json::from_slice(&answer).map_err(|err| {
            TranslatorError(format!("could not run TransLaTeX: the worker's answer was not understood ({err})"))
        })?;
        Ok(answers
            .into_iter()
            .map(|Answer { value, errors }| Translation {
                value,
                // The library reports an error as its stack trace; the first line is the message.
                errors: errors.into_iter().map(|error| error.lines().next().unwrap_or_default().to_owned()).collect(),
            })
            .collect())
    }
}
