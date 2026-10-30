// SPDX-License-Identifier: MIT

//! The vocabulary, the lexicon and the published language design must say the same thing.
//!
//! The design's tables (docs/l0187-language-design.md §3) are compared with [`vocab`] word for
//! word: the words and their arities, every property word, the allowed-property sets, the
//! container children and the closed sets. The served lexicon must be the committed
//! `generated/lexicon.json`, and every test program must parse to words the lexicon defines
//! (and, unless it is an `invalid-*` program, parse without error).

use std::collections::{BTreeMap, BTreeSet};

use graffiticode_l0000::{Ast, Node, Op};
use graffiticode_l0187::lexicon::{lexicon, lexicon_json};
use graffiticode_l0187::vocab::{
    self, CONTAINERS, MEMBERS, PROPERTIES, SAVE_TO_FIGJAM, TAG_SETS, ValueType, node_tag, word_of_tag,
};
use serde::Deserialize;
use serde_json::Value as Json;

const DESIGN: &str = include_str!("../../../../../docs/l0187-language-design.md");
const GENERATED_LEXICON: &str = include_str!("../../../generated/lexicon.json");

/// The rows of the markdown table whose header row starts with `header`, as the backticked
/// words in each cell.
fn table(header: &str) -> Vec<Vec<Vec<String>>> {
    let mut lines = DESIGN.lines().skip_while(|line| !line.starts_with(header));
    assert!(lines.next().is_some(), "the design has no table headed {header:?}");
    lines
        .skip(1) // the | --- | row
        .take_while(|line| line.starts_with('|'))
        .map(|line| line.trim_matches('|').split('|').map(backticked).collect())
        .collect()
}

fn backticked(cell: &str) -> Vec<String> {
    cell.split('`').skip(1).step_by(2).map(str::to_owned).collect()
}

fn set<'a>(words: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
    words.into_iter().map(str::to_owned).collect()
}

#[test]
fn construct_words_and_arities_match_the_design() {
    let mut design = BTreeMap::new();
    for row in table("| Word | Arity | Meaning |") {
        let arity: u32 = DESIGN
            .lines()
            .find(|line| line.starts_with(&format!("| `{}` |", row[0][0])))
            .and_then(|line| line.split('|').nth(2))
            .and_then(|cell| cell.trim().parse().ok())
            .expect("an arity");
        design.insert(row[0][0].clone(), arity);
    }
    let mut ours = BTreeMap::new();
    for c in &CONTAINERS {
        ours.insert(c.word.to_owned(), 2);
    }
    for m in &MEMBERS {
        ours.insert(m.word.to_owned(), 1);
    }
    ours.insert(SAVE_TO_FIGJAM.to_owned(), 1);
    assert_eq!(ours, design);
    for (word, arity) in &ours {
        assert_eq!(lexicon().get(word).map(|e| e.arity), Some(*arity), "{word}");
    }
}

#[test]
fn property_words_match_the_design() {
    let design: BTreeSet<String> =
        table("| Word | Value | Meaning |").into_iter().flat_map(|row| row[0].clone()).collect();
    assert_eq!(set(PROPERTIES.iter().map(|p| p.word)), design);
    for p in &PROPERTIES {
        assert_eq!(lexicon().get(p.word).map(|e| e.arity), Some(2), "{}", p.word);
    }
}

#[test]
fn allowed_property_sets_match_the_design() {
    for row in table("| Description | Allowed properties |") {
        let member = vocab::member(&row[0][0]).expect("a member");
        assert_eq!(set(member.properties.iter().copied()), set(row[1].iter().map(String::as_str)), "{}", member.word);
    }
    assert_eq!(table("| Description | Allowed properties |").len(), MEMBERS.len());
    for row in table("| Container settings | Allowed properties |") {
        let container = vocab::container(&row[0][0]).expect("a container");
        assert_eq!(
            set(container.settings.iter().copied()),
            set(row[1].iter().map(String::as_str)),
            "{}",
            container.word
        );
    }
    assert_eq!(table("| Container settings | Allowed properties |").len(), CONTAINERS.len());
}

#[test]
fn container_children_match_the_design() {
    let rows = table("| Container | Allowed children |");
    assert_eq!(rows.len(), CONTAINERS.len());
    for row in rows {
        let container = vocab::container(&row[0][0]).expect("a container");
        assert_eq!(
            set(container.children.iter().copied()),
            set(row[1].iter().map(String::as_str)),
            "{}",
            container.word
        );
    }
}

#[test]
fn closed_sets_match_the_design() {
    let rows = table("| Property | Initial tags |");
    let mut covered = BTreeSet::new();
    for row in rows {
        let tags = set(row[1].iter().map(String::as_str));
        for word in &row[0] {
            let property = vocab::property(word).expect("a property");
            let ValueType::Tag(tag_set) = property.value else { panic!("{word} takes no tag") };
            assert_eq!(set(tag_set.names()), tags, "{word}");
            covered.insert(tag_set.name);
        }
    }
    assert_eq!(covered, TAG_SETS.iter().map(|s| s.name).collect());
    for set in TAG_SETS {
        for tag in set.names() {
            let entry = lexicon().get(tag).expect("a tag in the lexicon");
            assert_eq!((entry.name.as_str(), entry.arity), ("TAG", 0), "{tag}");
        }
    }
}

#[test]
fn required_properties_match_the_design() {
    // §3: "`id` is required on every page, section, group, mark, and connector. `text` is
    // required on stickies, shapes, and textboxes. `name` is required on pages and sections.
    // `from` and `to` are required on connectors."
    for m in &MEMBERS {
        let mut expected = vec!["id"];
        if m.word == "connector" {
            expected.extend(["from", "to"]);
        } else {
            expected.push("text");
        }
        assert_eq!(set(m.required.iter().copied()), set(expected), "{}", m.word);
    }
    for c in &CONTAINERS {
        let expected: &[&str] = match c.word {
            "board" => &[],
            "group" => &["id"],
            _ => &["id", "name"],
        };
        assert_eq!(set(c.required.iter().copied()), set(expected.iter().copied()), "{}", c.word);
    }
}

#[test]
fn removed_geometry_words_match_the_design_and_are_not_in_the_lexicon() {
    // §6: "The authoring vocabulary excludes `x`, `y`, `width`, …"
    let section = DESIGN.split("The authoring vocabulary excludes").nth(1).expect("§6");
    let sentence = section.split(". ").next().unwrap();
    assert_eq!(set(backticked(sentence).iter().map(String::as_str)), set(vocab::REMOVED_GEOMETRY));
    for word in vocab::REMOVED_GEOMETRY.iter().chain(&vocab::REMOVED_OTHER) {
        assert!(lexicon().get(word).is_none(), "{word} is in the lexicon");
    }
}

#[test]
fn the_lexicon_shadows_no_base_word_and_is_committed() {
    for word in PROPERTIES.iter().map(|p| p.word).chain(MEMBERS.iter().map(|m| m.word)) {
        assert_eq!(lexicon().get(word).unwrap().name, node_tag(word));
    }
    assert!(lexicon_json() == GENERATED_LEXICON, "generated/lexicon.json is stale: run `npm run emit`");
}

#[derive(Deserialize)]
struct Case {
    name: String,
    ast: Json,
}

#[test]
fn every_test_program_parses_to_known_words() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("cases.json")).unwrap();
    assert!(!cases.is_empty());
    for case in &cases {
        let ast = Ast::from_json(&case.ast).unwrap_or_else(|e| panic!("{}: {e}", case.name));
        for (_, node) in ast.nodes() {
            if let Node::Form { op: Op::Dialect(tag), .. } = node {
                assert!(word_of_tag(tag).is_some(), "{}: {tag} is not an L0187 word", case.name);
            }
            let parse_error = matches!(node, Node::Form { op: Op::Error, .. });
            assert!(!parse_error || case.name.starts_with("invalid-"), "{}: a parse error", case.name);
        }
    }
}
