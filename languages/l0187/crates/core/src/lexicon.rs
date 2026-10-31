// SPDX-License-Identifier: MIT

//! The lexicon the parser reads, derived from [`crate::vocab`]: L0187's words merged over
//! L0000's, shadowing none of them.

use std::sync::LazyLock;

use graffiticode_l0000::{Lexicon, LexiconEntry};
use indexmap::IndexMap;

use crate::vocab::{CONTAINERS, MEMBERS, PROPERTIES, SAVE_TO_FIGJAM, SAVE_TO_FIGJAM_DESCRIPTION, TAG_SETS, node_tag};

/// The parser's token kind for a function word and for a tag.
const TK_FUNCTION: u32 = 1;
const TK_TAG: u32 = 22;

fn function(word: &str, arity: u32, signature: String, description: &str) -> (String, LexiconEntry) {
    let entry = LexiconEntry {
        tk: TK_FUNCTION,
        name: node_tag(word),
        cls: "function".to_owned(),
        arity,
        signature: Some(signature),
        description: Some(description.to_owned()),
        extra: IndexMap::new(),
    };
    (word.to_owned(), entry)
}

/// The words L0187 adds: containers, members, properties, the statement, then every tag.
pub fn additions() -> Lexicon {
    let containers = CONTAINERS.iter().map(|c| function(c.word, 2, "<list record: record>".to_owned(), c.description));
    let members = MEMBERS.iter().map(|m| function(m.word, 1, "<record: record>".to_owned(), m.description));
    let properties = PROPERTIES
        .iter()
        .map(|p| function(p.word, 2, format!("<{} record: record>", p.value.signature()), p.description));
    let statement = function(SAVE_TO_FIGJAM, 1, "<string: record>".to_owned(), SAVE_TO_FIGJAM_DESCRIPTION);
    let tags = TAG_SETS.iter().flat_map(|set| set.tags.iter()).map(|(tag, description)| {
        let entry = LexiconEntry {
            tk: TK_TAG,
            name: "TAG".to_owned(),
            cls: "val".to_owned(),
            arity: 0,
            signature: Some("<: tag>".to_owned()),
            description: Some((*description).to_owned()),
            extra: IndexMap::new(),
        };
        ((*tag).to_owned(), entry)
    });
    containers.chain(members).chain(properties).chain([statement]).chain(tags).collect()
}

static LEXICON: LazyLock<Lexicon> =
    LazyLock::new(|| Lexicon::base().merge(additions(), &[], Some("L0187")).expect("L0187 redefines no base word"));

/// L0187's vocabulary: the base lexicon with L0187's words laid over it, as served at
/// `/lexicon.json`.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// The lexicon as the JSON document `generated/lexicon.json` holds.
pub fn lexicon_json() -> String {
    serde_json::to_string_pretty(lexicon()).expect("a lexicon serializes") + "\n"
}
