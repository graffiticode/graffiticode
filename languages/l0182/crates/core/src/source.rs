// SPDX-License-Identifier: MIT

//! Where a survey's data comes from (`source.ts`).
//!
//! A program says which survey is being taken and nothing about what is in it; the compiler
//! reads the survey here. A survey is one JSON file per version, `<id>-<n>.json` in
//! `packages/core/data/`, embedded in the crate at build time (see `build.rs`).
//!
//! An id naming a survey (`civic-priorities`) DRAWS one of its versions at random, without
//! replacement: a drawn version is marked taken until every version has been taken, then the
//! marks clear. An id naming a version (`civic-priorities-7`) loads it outright, with no draw and
//! no mark. A session that has drawn before gets the same version back, so a response checks
//! against the options its taker saw. That memory is per server process, as in the TypeScript.
//!
//! [`SurveySource`] is the seam (`setSource` in the TypeScript): the dialect holds one, and
//! nothing else in the language changes if a survey stops coming from a file.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde_json::Value as Json;

use crate::js::{Js, js_string, stringify};

/// A survey file, parsed. `instance` is the version taken: its file name without the
/// extension, or the id as written when the id named the version.
pub struct Loaded {
    pub instance: Js,
    pub data: Js,
}

/// Finds the survey a program names. `id` is the program's `id` as written; `session` the
/// trimmed, non-empty `session-id`, if any.
pub trait SurveySource: Send + Sync {
    fn load(&self, id: &Js, session: Option<&str>) -> Result<Loaded, String>;
}

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/surveys.rs"));
}

/// Which version each survey has handed out, and which sessions hold which version.
#[derive(Default)]
struct Draws {
    taken: HashMap<String, HashSet<String>>,
    drawn: HashMap<String, (String, String)>,
}

/// The file source: the installed surveys, drawn from at random.
pub struct Files {
    /// Each file's name without `.json`, and its text.
    files: Vec<(String, &'static str)>,
    draws: Mutex<Draws>,
    /// Picks an index below the given length: `Math.floor(Math.random() * length)`.
    pick: fn(usize) -> usize,
}

impl Default for Files {
    fn default() -> Self {
        Files::installed(|len| fastrand::usize(..len))
    }
}

/// `^[a-z0-9][a-z0-9-]*$`: nothing resembling a path reaches a file lookup.
fn is_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The digits after a name's last dash, when that is how it ends (`^(.*)-(\d+)$`).
fn version_of(name: &str) -> Option<(&str, &str)> {
    name.rsplit_once('-').filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

impl Files {
    /// The surveys installed in `packages/core/data`, drawn from with `pick`.
    pub fn installed(pick: fn(usize) -> usize) -> Files {
        let files = embedded::FILES
            .iter()
            .filter_map(|(name, text)| name.strip_suffix(".json").map(|name| (name.to_owned(), *text)))
            .collect();
        Files { files, draws: Mutex::default(), pick }
    }

    fn read(&self, instance: &str) -> Result<Option<Js>, String> {
        let Some((_, text)) = self.files.iter().find(|(name, _)| name == instance) else { return Ok(None) };
        let json: Json = serde_json::from_str(text).map_err(|e| {
            format!(
                "survey: {instance}.json is not readable JSON — {e}. The survey's data is broken; this is not something the program can fix."
            )
        })?;
        Ok(Some(Js::from_json(&json)))
    }

    /// The versions of a survey, in version order.
    fn instances_of(&self, id: &str) -> Vec<String> {
        let mut found: Vec<(f64, &str)> = self
            .files
            .iter()
            .filter_map(|(name, _)| {
                let n = name.strip_prefix(id)?.strip_prefix('-')?;
                (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                    .then(|| (n.parse().unwrap_or(f64::NAN), name.as_str()))
            })
            .collect();
        found.sort_by(|a, b| a.0.total_cmp(&b.0));
        found.into_iter().map(|(_, name)| name.to_owned()).collect()
    }

    /// Every survey there is, for the "no such survey" message.
    fn survey_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .files
            .iter()
            .filter_map(|(name, _)| version_of(name).map(|(id, _)| id).filter(|id| !id.is_empty()))
            .map(str::to_owned)
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Draws an untaken version, refilling when every one has been taken.
    fn draw(&self, draws: &mut Draws, id: &str, instances: &[String]) -> String {
        let marks = draws.taken.entry(id.to_owned()).or_default();
        let mut untaken: Vec<&String> = instances.iter().filter(|i| !marks.contains(*i)).collect();
        if untaken.is_empty() {
            marks.clear();
            untaken = instances.iter().collect();
        }
        let chosen = untaken[(self.pick)(untaken.len()).min(untaken.len() - 1)].clone();
        marks.insert(chosen.clone());
        chosen
    }
}

impl SurveySource for Files {
    fn load(&self, id: &Js, session: Option<&str>) -> Result<Loaded, String> {
        let text = js_string(id);
        if !is_id(&text) {
            return Err(format!(
                "survey: {} is not a survey id. An id is lower-case letters, digits and dashes, e.g. id \"civic-priorities\".",
                stringify(id)
            ));
        }

        // An id naming a version loads it outright: no draw, and no mark.
        if version_of(&text).is_some()
            && let Some(data) = self.read(&text)?
        {
            return Ok(Loaded { instance: id.clone(), data });
        }

        let instances = self.instances_of(&text);
        if instances.is_empty() {
            let available = self.survey_ids();
            return Err(format!(
                "survey: there is no survey with id {}. {}",
                stringify(id),
                if available.is_empty() {
                    "No surveys are installed on this language server.".to_owned()
                } else {
                    format!("The surveys available are: {}.", available.join(", "))
                }
            ));
        }

        let instance = {
            let mut draws = self.draws.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let held =
                session.and_then(|s| draws.drawn.get(s)).filter(|(held, _)| matches!(id, Js::Str(id) if id == held));
            match held {
                Some((_, instance)) => instance.clone(),
                None => {
                    let instance = self.draw(&mut draws, &text, &instances);
                    if let (Some(session), Js::Str(id)) = (session, id) {
                        draws.drawn.insert(session.to_owned(), (id.clone(), instance.clone()));
                    }
                    instance
                }
            }
        };
        let data = self.read(&instance)?.unwrap_or(Js::Undefined);
        Ok(Loaded { instance: Js::Str(instance), data })
    }
}

/// One survey, served whatever id is asked for, as `{id}-1` — the shape the TypeScript suite's
/// `setSource` fixtures take, and the conformance test's.
pub struct Fixture(pub Json);

impl SurveySource for Fixture {
    fn load(&self, id: &Js, _session: Option<&str>) -> Result<Loaded, String> {
        Ok(Loaded { instance: Js::Str(format!("{}-1", js_string(id))), data: Js::from_json(&self.0) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn str(s: &str) -> Js {
        Js::Str(s.to_owned())
    }

    fn instance(loaded: Result<Loaded, String>) -> String {
        js_string(&loaded.unwrap().instance)
    }

    #[test]
    fn the_surveys_are_embedded() {
        let files = Files::default();
        assert!(files.survey_ids().contains(&"civic-priorities".to_owned()));
        let versions = files.instances_of("civic-priorities");
        assert_eq!(versions.len(), 12);
        // In version order, not name order.
        assert_eq!(versions[1], "civic-priorities-2");
        assert_eq!(versions[11], "civic-priorities-12");
        // `civic` is not a prefix match.
        assert!(files.instances_of("civic").is_empty());
    }

    #[test]
    fn a_draw_takes_every_version_before_any_twice() {
        let files = Files::default();
        let versions = files.instances_of("civic-priorities").len();
        let mut seen = HashSet::new();
        for _ in 0..versions {
            seen.insert(instance(files.load(&str("civic-priorities"), None)));
        }
        assert_eq!(seen.len(), versions);
        // The marks cleared: the next cycle starts over.
        assert!(seen.contains(&instance(files.load(&str("civic-priorities"), None))));
    }

    #[test]
    fn a_named_version_neither_draws_nor_marks() {
        let files = Files::installed(|_| 0);
        assert_eq!(instance(files.load(&str("civic-priorities-7"), None)), "civic-priorities-7");
        assert_eq!(instance(files.load(&str("civic-priorities"), None)), "civic-priorities-1");
        assert_eq!(instance(files.load(&str("civic-priorities"), None)), "civic-priorities-2");
    }

    #[test]
    fn a_session_keeps_its_version() {
        let files = Files::installed(|len| len - 1);
        let first = instance(files.load(&str("civic-priorities"), Some("s")));
        assert_eq!(first, "civic-priorities-12");
        for _ in 0..3 {
            assert_eq!(instance(files.load(&str("civic-priorities"), Some("s"))), first);
        }
        // Another session draws afresh, and so does the same session taking another survey.
        assert_eq!(instance(files.load(&str("civic-priorities"), Some("t"))), "civic-priorities-11");
        assert_eq!(instance(files.load(&str("workplace-pulse"), Some("s"))), "workplace-pulse-3");
        assert_eq!(instance(files.load(&str("civic-priorities"), Some("s"))), "civic-priorities-10");
    }

    #[test]
    fn an_id_that_is_not_an_id_is_refused_before_any_lookup() {
        let files = Files::default();
        for bad in ["../spec/spec", "/etc/passwd", "civic-priorities/../..", "-leading", "Civic", ""] {
            let error = files.load(&str(bad), None).err().unwrap();
            assert!(error.contains("is not a survey id"), "{bad}: {error}");
        }
        let error = files.load(&str("no-such-survey"), None).err().unwrap();
        assert!(error.contains("there is no survey with id \"no-such-survey\""));
        assert!(error.contains("civic-priorities"));
    }
}
