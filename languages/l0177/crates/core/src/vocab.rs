// SPDX-License-Identifier: MIT

//! The vocabulary: every view, member, section and top-level property, with each field's
//! Learnosity path and type.
//!
//! A property's meaning depends on where it appears — `status` is a boolean under
//! `config.item_list.item` but a list of states under `config.item_list.filter.restricted` —
//! so fields are keyed by view and member, and each carries its path and type. The path is
//! recorded because the kebab name alone does not say its separator: `title-show` is
//! `title.show`, but `enable-selection` is `enable_selection`.
//!
//! `vocab.json` is generated from `packages/core/src/vocab.ts`, the single source of truth.
//! Change the vocabulary there and regenerate.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde_json::Value as Json;

/// One field: where it lands in Learnosity's config, its type, and for a string or list of
/// strings the values it accepts, or for a list of records their schema.
#[derive(Debug, Clone)]
pub struct Field {
    pub path: Option<String>,
    pub kind: String,
    pub values: Option<Vec<String>>,
    pub schema: Option<Fields>,
}

pub type Fields = IndexMap<String, Field>;

#[derive(Debug)]
pub struct Member {
    pub path: String,
    pub fields: Fields,
}

#[derive(Debug)]
pub struct View {
    /// The Learnosity mode the view selects.
    pub mode: String,
    /// The view's own scalars, `config.<mode>.<field>`.
    pub view: Fields,
    pub members: IndexMap<String, Member>,
}

pub struct Vocab {
    pub views: IndexMap<String, View>,
    pub sections: IndexMap<String, Member>,
    pub toplevel: Fields,
    /// Question-type groups, the granularity the Author API restricts at, by tag.
    pub group_tags: IndexMap<String, String>,
    /// Widget types by tag.
    pub widget_tags: IndexMap<String, String>,
}

fn field(json: &Json) -> Field {
    let parts = json.as_array().expect("a field is [path, type, constraint?]");
    let (values, schema) = match parts.get(2) {
        Some(Json::Array(values)) => (Some(values.iter().filter_map(Json::as_str).map(str::to_owned).collect()), None),
        Some(schema @ Json::Object(_)) => (None, Some(fields(schema))),
        _ => (None, None),
    };
    Field {
        path: parts[0].as_str().map(str::to_owned),
        kind: parts[1].as_str().expect("a field has a type").to_owned(),
        values,
        schema,
    }
}

fn fields(json: &Json) -> Fields {
    json.as_object().into_iter().flatten().map(|(name, spec)| (name.clone(), field(spec))).collect()
}

fn member(json: &Json) -> Member {
    Member { path: json["path"].as_str().expect("a member has a path").to_owned(), fields: fields(&json["fields"]) }
}

fn names(json: &Json) -> IndexMap<String, String> {
    json.as_object()
        .into_iter()
        .flatten()
        .map(|(tag, name)| (tag.clone(), name.as_str().expect("a tag names a string").to_owned()))
        .collect()
}

static VOCAB: LazyLock<Vocab> = LazyLock::new(|| {
    let json: Json = serde_json::from_str(include_str!("vocab.json")).expect("the embedded vocabulary is valid");
    let views = json["views"]
        .as_object()
        .expect("views")
        .iter()
        .map(|(name, view)| {
            let members = view["members"].as_object().expect("members").iter().map(|(n, m)| (n.clone(), member(m)));
            let view = View {
                mode: view["mode"].as_str().expect("a view has a mode").to_owned(),
                view: fields(&view["view"]),
                members: members.collect(),
            };
            (name.clone(), view)
        })
        .collect();
    Vocab {
        views,
        sections: json["sections"].as_object().expect("sections").iter().map(|(n, s)| (n.clone(), member(s))).collect(),
        toplevel: fields(&json["toplevel"]),
        group_tags: names(&json["groupTags"]),
        widget_tags: names(&json["widgetTags"]),
    }
});

pub fn vocab() -> &'static Vocab {
    &VOCAB
}

impl Vocab {
    /// Every property keyword, in any context.
    pub fn is_property(&self, word: &str) -> bool {
        self.toplevel.contains_key(word)
            || self.sections.values().any(|section| section.fields.contains_key(word))
            || self
                .views
                .values()
                .any(|view| view.view.contains_key(word) || view.members.values().any(|m| m.fields.contains_key(word)))
    }

    /// Every member keyword, in any view.
    pub fn is_member(&self, word: &str) -> bool {
        self.views.values().any(|view| view.members.contains_key(word))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vocabulary_loads_with_its_four_views() {
        let vocab = vocab();
        assert_eq!(
            vocab.views.keys().collect::<Vec<_>>(),
            ["item-edit", "item-list", "activity-edit", "activity-list"]
        );
        assert_eq!(
            vocab.views["item-list"].members["filter-restricted"].fields["status"].values.as_ref().unwrap().len(),
            3
        );
        let banks = &vocab.views["activity-edit"].members["item-search"].fields["item-banks"];
        assert_eq!(banks.schema.as_ref().unwrap()["filter"].kind, "unmodeled");
        assert_eq!(vocab.toplevel["allow-widgets"].path, None);
        assert_eq!(vocab.group_tags.len(), 10);
        // A keyword is a member or a property, never both: it has one arity.
        for view in vocab.views.values() {
            for member in view.members.keys() {
                assert!(!vocab.is_property(member), "{member}");
            }
        }
    }
}
