// SPDX-License-Identifier: MIT

//! The learning targets, and what each allows.
//!
//! L0175 is one language over several Smarter Balanced targets. Composition is the same for
//! all of them; only the vocabulary differs: the passage type a target expects, its standards,
//! its dimensions, its distractor taxonomy and which item type each of its task models is.
//!
//! `targets.json` is generated from `packages/core/src/targets.ts`, which is the single source
//! of truth for every fact here. Change a target there and regenerate.

use std::sync::LazyLock;

use indexmap::{IndexMap, IndexSet};
use serde::Deserialize;

/// The target a program is composed against when it names none, or one that does not exist.
pub const DEFAULT: &str = "c1-t4";

/// What an item's answer options are made of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnswerKind {
    /// Claims the student chooses among.
    Statement,
    /// Passage sources: the inference is given in the stem, and the student finds its support.
    Evidence,
    /// The candidate meanings of a targeted word.
    Meaning,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    /// The guideline's grade band, and so the reading level a passage is held to by default.
    pub grade: f64,
    /// The passage type this target expects.
    pub text_type: String,
    /// The cite-evidence standard every item of this target carries.
    pub base_standard: String,
    /// The depth of knowledge of this target's selected-response items.
    pub default_dok: String,
    pub answer_kind: AnswerKind,
    /// Whether Hot Text is one part (click the supporting sentences) or follows a Part A.
    pub single_part_hot_text: bool,
    /// Task model to item type. The numbers are per target and collide across targets, so a
    /// task model means nothing without its target.
    pub task_models: IndexMap<String, String>,
    #[serde(rename = "standards")]
    standard_families: Vec<String>,
    pub dimensions: Vec<String>,
    /// The distractor taxonomy, in the order coverage is sought.
    pub error_types: Vec<String>,
    /// Each dimension's companion standard.
    pub dim_standard: IndexMap<String, String>,
    #[serde(skip)]
    pub standards: Vec<String>,
}

impl Target {
    /// The item types this target offers, in task-model order.
    pub fn item_types(&self) -> IndexSet<&str> {
        self.task_models.values().map(String::as_str).collect()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    standard_families: IndexMap<String, Vec<String>>,
    targets: IndexMap<String, Target>,
}

pub struct Targets {
    by_id: IndexMap<String, Target>,
}

impl Targets {
    pub fn get(&self, id: &str) -> Option<&Target> {
        self.by_id.get(id)
    }

    pub fn default_target(&self) -> &Target {
        &self.by_id[DEFAULT]
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.by_id.keys().map(String::as_str)
    }

    /// Every item type any target offers.
    pub fn item_types(&self) -> IndexSet<&str> {
        self.by_id.values().flat_map(Target::item_types).collect()
    }
}

static TARGETS: LazyLock<Targets> = LazyLock::new(|| {
    let source: Source = serde_json::from_str(include_str!("targets.json")).expect("the embedded targets are valid");
    let mut by_id = source.targets;
    for target in by_id.values_mut() {
        target.standards = target
            .standard_families
            .iter()
            .flat_map(|family| source.standard_families.get(family).expect("a target names a known family"))
            .cloned()
            .collect();
    }
    assert!(by_id.contains_key(DEFAULT), "the default target exists");
    Targets { by_id }
});

pub fn targets() -> &'static Targets {
    &TARGETS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_targets_load() {
        let targets = targets();
        assert_eq!(
            targets.ids().collect::<Vec<_>>(),
            ["c1-t4", "c1-t11", "c1-t2", "c1-t9", "c1-t1", "c1-t8", "c1-t10"]
        );
        assert_eq!(
            targets.item_types().into_iter().collect::<Vec<_>>(),
            ["ebsr", "hot-text", "short-text", "multiple-choice", "multi-select"]
        );
        let t10 = targets.get("c1-t10").unwrap();
        assert_eq!(t10.answer_kind, AnswerKind::Meaning);
        assert!(t10.standards.contains(&"ri-4".to_owned()) && t10.standards.contains(&"l-4a".to_owned()));
        // The same number is a different item type in a different target.
        assert_eq!(targets.get("c1-t4").unwrap().task_models["tm3"], "short-text");
        assert_eq!(targets.get("c1-t9").unwrap().task_models["tm3"], "ebsr");
    }
}
