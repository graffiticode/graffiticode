// SPDX-License-Identifier: MIT

//! L0187's vocabulary as data: every word, its arity, the value it takes, where it is legal and
//! what it means. This is the single source of truth: the lexicon the parser reads, the
//! evaluation handlers, the legality checks and the published tables are all derived from it
//! (docs/l0187-language-design.md §3, §12).
//!
//! Four construct shapes (docs/language-style-typed-chains.md):
//!
//! | Shape     | Arity | Form                              |
//! | --------- | ----- | --------------------------------- |
//! | container | 2     | `section [ members ] settings {}` |
//! | member    | 1     | `sticky id "a" text "A" {}`       |
//! | property  | 2     | `text "A" fill "yellow" {}`       |
//! | tag       | 0     | `DIAMOND`, `ROW`, `RIGHT`         |
//!
//! plus one statement, `save-to-figjam`, which takes the destination file.

/// The value a property takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValueType {
    /// A nonempty string with no surrounding white space, not `"*"`: a semantic identity.
    Id,
    /// One id string naming another object: a connector's `from` or `to`.
    IdRef,
    /// A nonempty list of id strings: `before`.
    IdList,
    /// Any string, including the empty string: the full text of a mark or label.
    Text,
    /// A nonempty string: a page, section or board name.
    Name,
    /// One of a closed set of bare uppercase tags.
    Tag(&'static TagSet),
    /// A positive integer: `columns`.
    Count,
    /// A number from 0 to 100.
    Opacity,
    /// A three- or six-digit hex string, or one of [`NAMED_COLORS`].
    Color,
    /// `true` or `false`.
    Boolean,
}

impl ValueType {
    /// The value's type in a lexicon signature.
    pub fn signature(self) -> &'static str {
        match self {
            ValueType::Id | ValueType::IdRef | ValueType::Text | ValueType::Name | ValueType::Color => "string",
            ValueType::IdList => "list",
            ValueType::Tag(_) => "tag",
            ValueType::Count | ValueType::Opacity => "number",
            ValueType::Boolean => "boolean",
        }
    }
}

/// A closed set of tags and what each means.
#[derive(Debug, PartialEq, Eq)]
pub struct TagSet {
    pub name: &'static str,
    pub tags: &'static [(&'static str, &'static str)],
}

impl TagSet {
    pub fn contains(&self, tag: &str) -> bool {
        self.tags.iter().any(|(name, _)| *name == tag)
    }

    pub fn names(&self) -> impl Iterator<Item = &'static str> {
        self.tags.iter().map(|(name, _)| *name)
    }
}

pub static LAYOUTS: TagSet = TagSet {
    name: "layout",
    tags: &[
        ("AUTO", "Arrange the children as the compiler sees fit, using containment and connections."),
        ("ROW", "Keep the children in order, left to right, without wrapping."),
        ("COLUMN", "Keep the children in order, top to bottom, without wrapping."),
        ("GRID", "Keep the children in order, row by row, in `columns` columns."),
        ("FLOW", "Lay the children out along `direction`, following their connectors and `before` orders."),
    ],
};

pub static DIRECTIONS: TagSet = TagSet {
    name: "direction",
    tags: &[
        ("RIGHT", "A flow that progresses left to right."),
        ("LEFT", "A flow that progresses right to left."),
        ("DOWN", "A flow that progresses top to bottom."),
        ("UP", "A flow that progresses bottom to top."),
    ],
};

pub static SHAPE_KINDS: TagSet = TagSet {
    name: "kind",
    tags: &[
        ("SQUARE", "A square shape (the default)."),
        ("ROUNDED_RECTANGLE", "A rectangle with rounded corners."),
        ("ELLIPSE", "An ellipse."),
        ("DIAMOND", "A diamond."),
        ("PARALLELOGRAM_RIGHT", "A parallelogram leaning right."),
        ("PREDEFINED_PROCESS", "A rectangle with a bar at each side."),
        ("DOCUMENT_SINGLE", "A page with a wavy bottom edge."),
        ("ENG_DATABASE", "A cylinder."),
    ],
};

pub static FONT_SIZES: TagSet = TagSet {
    name: "font-size",
    tags: &[
        ("SMALL", "16px text (the default for connector labels)."),
        ("MEDIUM", "24px text (the default for marks)."),
        ("LARGE", "40px text."),
        ("EXTRA_LARGE", "64px text."),
        ("HUGE", "96px text."),
    ],
};

pub static STROKE_WIDTHS: TagSet =
    TagSet { name: "stroke-width", tags: &[("THIN", "A 4px line (the default)."), ("THICK", "An 8px line.")] };

pub static LINE_STYLES: TagSet =
    TagSet { name: "line-style", tags: &[("SOLID", "A solid line (the default)."), ("DASHED", "A dashed line.")] };

pub static CAPS: TagSet = TagSet {
    name: "cap",
    tags: &[
        ("NONE", "No end cap (the default at a connector's start)."),
        ("ARROW_LINES", "An open arrowhead (the default at a connector's end)."),
        ("ARROW_EQUILATERAL", "A filled arrowhead."),
        ("TRIANGLE_FILLED", "A filled triangle."),
        ("CIRCLE_FILLED", "A filled circle."),
        ("DIAMOND_FILLED", "A filled diamond."),
    ],
};

pub static PROFILES: TagSet = TagSet {
    name: "layout-profile",
    tags: &[("FIGJAM_V1", "The first measurement, layout and validation profile (the default).")],
};

/// Every closed set, each listed once.
pub static TAG_SETS: [&TagSet; 8] =
    [&LAYOUTS, &DIRECTIONS, &SHAPE_KINDS, &FONT_SIZES, &STROKE_WIDTHS, &LINE_STYLES, &CAPS, &PROFILES];

/// The colour names a colour may be given as, besides a hex code.
pub const NAMED_COLORS: [&str; 10] =
    ["red", "blue", "green", "yellow", "purple", "orange", "pink", "white", "black", "gray"];

/// A property word: arity 2, a value and then the rest of the description.
#[derive(Debug)]
pub struct Property {
    pub word: &'static str,
    pub value: ValueType,
    pub description: &'static str,
}

/// A member word: arity 1, one description.
#[derive(Debug)]
pub struct Member {
    pub word: &'static str,
    /// The properties its description may have, in the order the design lists them.
    pub properties: &'static [&'static str],
    /// The properties it must have.
    pub required: &'static [&'static str],
    pub description: &'static str,
    pub example: &'static str,
}

/// A container word: arity 2, a list of members and then a settings description.
#[derive(Debug)]
pub struct Container {
    pub word: &'static str,
    /// The member and container words its list may hold.
    pub children: &'static [&'static str],
    /// The properties its settings may have.
    pub settings: &'static [&'static str],
    /// The settings it must have.
    pub required: &'static [&'static str],
    pub description: &'static str,
    pub example: &'static str,
}

/// The one statement: `save-to-figjam "<file key or link>"`, on its own line beside the board.
pub const SAVE_TO_FIGJAM: &str = "save-to-figjam";
pub const SAVE_TO_FIGJAM_DESCRIPTION: &str = "Draw this board into a FigJam file with the Graffiticode FigJam plugin: `save-to-figjam \"<file key or figma.com link>\"`, on its own line before the board. Without it the board is a preview.";

pub static PROPERTIES: [Property; 25] = [
    Property {
        word: "id",
        value: ValueType::Id,
        description: "The object's identity, unique on the board. Connectors and `before` refer to it. Required on every page, section, group, mark and connector.",
    },
    Property {
        word: "text",
        value: ValueType::Text,
        description: "The full plain text of a sticky, shape or textbox. Required on each; it may be empty.",
    },
    Property {
        word: "name",
        value: ValueType::Name,
        description: "A page's or section's name, shown as its tab or title. Required on both.",
    },
    Property { word: "title", value: ValueType::Name, description: "The board's title, after the board's `]`." },
    Property {
        word: "kind",
        value: ValueType::Tag(&SHAPE_KINDS),
        description: "A shape's outline: SQUARE (the default), ROUNDED_RECTANGLE, ELLIPSE, DIAMOND, PARALLELOGRAM_RIGHT, PREDEFINED_PROCESS, DOCUMENT_SINGLE or ENG_DATABASE.",
    },
    Property {
        word: "layout",
        value: ValueType::Tag(&LAYOUTS),
        description: "How a page, section or group arranges its direct children: AUTO (the default), ROW, COLUMN, GRID (with `columns`) or FLOW (with an optional `direction`).",
    },
    Property {
        word: "direction",
        value: ValueType::Tag(&DIRECTIONS),
        description: "The direction a FLOW progresses: RIGHT (the default), LEFT, DOWN or UP. Only with `layout FLOW`.",
    },
    Property {
        word: "columns",
        value: ValueType::Count,
        description: "How many columns a GRID has: a positive whole number. Only with `layout GRID`, which requires it.",
    },
    Property {
        word: "before",
        value: ValueType::IdList,
        description: "The ids of siblings this child must come before in its parent's FLOW, e.g. `before [\"b\" \"c\"]`. Only on a direct child of a `layout FLOW` region.",
    },
    Property {
        word: "from",
        value: ValueType::IdRef,
        description: "The id of the sticky, shape or textbox a connector starts at. Required.",
    },
    Property {
        word: "to",
        value: ValueType::IdRef,
        description: "The id of the sticky, shape or textbox a connector ends at. Required.",
    },
    Property { word: "label", value: ValueType::Text, description: "Text written on a connector." },
    Property {
        word: "fill",
        value: ValueType::Color,
        description: "The colour of a sticky, shape or section: a hex code like \"#ffcc00\", or red, blue, green, yellow, purple, orange, pink, white, black, gray.",
    },
    Property {
        word: "stroke",
        value: ValueType::Color,
        description: "The colour of a shape's outline or a connector's line.",
    },
    Property { word: "color", value: ValueType::Color, description: "The colour of a textbox's text." },
    Property { word: "background", value: ValueType::Color, description: "A page's canvas colour." },
    Property {
        word: "opacity",
        value: ValueType::Opacity,
        description: "How opaque, from 0 (invisible) to 100 (solid). Defaults to 100. An invisible object still takes its place in the layout.",
    },
    Property {
        word: "font-size",
        value: ValueType::Tag(&FONT_SIZES),
        description: "Text size: SMALL (16), MEDIUM (24, the default for marks), LARGE (40), EXTRA_LARGE (64) or HUGE (96). A connector label defaults to SMALL.",
    },
    Property {
        word: "stroke-width",
        value: ValueType::Tag(&STROKE_WIDTHS),
        description: "Line thickness: THIN (4, the default) or THICK (8).",
    },
    Property {
        word: "line-style",
        value: ValueType::Tag(&LINE_STYLES),
        description: "A connector's dash: SOLID (the default) or DASHED.",
    },
    Property {
        word: "from-cap",
        value: ValueType::Tag(&CAPS),
        description: "The cap at a connector's start: NONE (the default), ARROW_LINES, ARROW_EQUILATERAL, TRIANGLE_FILLED, CIRCLE_FILLED or DIAMOND_FILLED.",
    },
    Property {
        word: "to-cap",
        value: ValueType::Tag(&CAPS),
        description: "The cap at a connector's end: ARROW_LINES (the default), NONE, ARROW_EQUILATERAL, TRIANGLE_FILLED, CIRCLE_FILLED or DIAMOND_FILLED.",
    },
    Property {
        word: "show-page-tabs",
        value: ValueType::Boolean,
        description: "Show a tab per page in the preview. Defaults to true with two or more pages, false with one.",
    },
    Property {
        word: "show-page-menu",
        value: ValueType::Boolean,
        description: "Show the page menu in the preview. Defaults to false.",
    },
    Property {
        word: "layout-profile",
        value: ValueType::Tag(&PROFILES),
        description: "The fixed measurement, layout and validation policy the board is compiled with: FIGJAM_V1, which is also what an omitted profile means.",
    },
];

pub static MEMBERS: [Member; 4] = [
    Member {
        word: "sticky",
        properties: &["id", "text", "fill", "opacity", "font-size", "before"],
        required: &["id", "text"],
        description: "A sticky note of plain text, e.g. `sticky id \"idea\" text \"Idea\" {}`.",
        example: "sticky id \"idea\" text \"Idea\" {}",
    },
    Member {
        word: "shape",
        properties: &["id", "text", "kind", "fill", "stroke", "stroke-width", "opacity", "font-size", "before"],
        required: &["id", "text"],
        description: "A shape with text in it, e.g. `shape id \"valid\" text \"Valid?\" kind DIAMOND {}`.",
        example: "shape id \"valid\" text \"Valid?\" kind DIAMOND {}",
    },
    Member {
        word: "textbox",
        properties: &["id", "text", "color", "opacity", "font-size", "before"],
        required: &["id", "text"],
        description: "Standalone text, measured and wrapped by the compiler, e.g. `textbox id \"heading\" text \"Agenda\" font-size LARGE {}`.",
        example: "textbox id \"heading\" text \"Agenda\" {}",
    },
    Member {
        word: "connector",
        properties: &[
            "id",
            "from",
            "to",
            "label",
            "stroke",
            "stroke-width",
            "opacity",
            "font-size",
            "line-style",
            "from-cap",
            "to-cap",
        ],
        required: &["id", "from", "to"],
        description: "A line from one mark to another on the same page, e.g. `connector id \"a-b\" from \"a\" to \"b\" label \"next\" {}`. Written directly in the page.",
        example: "connector id \"a-b\" from \"a\" to \"b\" {}",
    },
];

pub static CONTAINERS: [Container; 4] = [
    Container {
        word: "board",
        children: &["page"],
        settings: &["title", "show-page-tabs", "show-page-menu", "layout-profile"],
        required: &[],
        description: "The program: the board's pages, then its settings (title, show-page-tabs, show-page-menu, layout-profile).",
        example: "board [ page [ sticky id \"idea\" text \"Idea\" {} ] id \"p1\" name \"Ideas\" {} ] {}",
    },
    Container {
        word: "page",
        children: &["sticky", "shape", "textbox", "section", "group", "connector"],
        settings: &["id", "name", "background", "layout", "direction", "columns"],
        required: &["id", "name"],
        description: "One page, arranged on its own: its marks, sections, groups and connectors, then its settings (id, name, background, layout, direction, columns).",
        example: "page [ sticky id \"idea\" text \"Idea\" {} ] id \"p1\" name \"Ideas\" {}",
    },
    Container {
        word: "section",
        children: &["sticky", "shape", "textbox", "group"],
        settings: &["id", "name", "fill", "opacity", "layout", "direction", "columns", "before"],
        required: &["id", "name"],
        description: "A visible, named area holding marks and groups, then its settings (id, name, fill, opacity, layout, direction, columns, before). A section cannot hold another section.",
        example: "section [ sticky id \"shipped\" text \"Shipped\" {} ] id \"went-well\" name \"Went well\" {}",
    },
    Container {
        word: "group",
        children: &["sticky", "shape", "textbox", "section", "group"],
        settings: &["id", "layout", "direction", "columns", "before"],
        required: &["id"],
        description: "An invisible layout region: arranges its children as one block, with no frame or title, then its settings (id, layout, direction, columns, before).",
        example: "group [ sticky id \"a\" text \"A\" {} ] id \"cards\" layout ROW {}",
    },
];

/// Words L0186 has and L0187 removed: geometry is the compiler's (design §6). Absent from the
/// lexicon; the compiler recognizes them to explain where placement went.
pub const REMOVED_GEOMETRY: [&str; 9] =
    ["x", "y", "width", "height", "from-side", "to-side", "line-type", "waypoints", "waypoint"];

/// Words L0186 has that are outside L0187's first release (design §1, §4).
pub const REMOVED_OTHER: [&str; 2] = ["stamp", "shape-type"];

pub fn property(word: &str) -> Option<&'static Property> {
    PROPERTIES.iter().find(|p| p.word == word)
}

pub fn member(word: &str) -> Option<&'static Member> {
    MEMBERS.iter().find(|m| m.word == word)
}

pub fn container(word: &str) -> Option<&'static Container> {
    CONTAINERS.iter().find(|c| c.word == word)
}

/// The closed set a tag belongs to.
pub fn tag_set(tag: &str) -> Option<&'static TagSet> {
    TAG_SETS.iter().copied().find(|set| set.contains(tag))
}

/// The node tag a word produces: `font-size` → `FONT_SIZE`.
pub fn node_tag(word: &str) -> String {
    word.to_uppercase().replace('-', "_")
}

/// The output field a word emits: `font-size` → `fontSize`.
pub fn field(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    let mut upper = false;
    for c in word.chars() {
        if c == '-' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// The word a node tag came from, for any L0187 word: `FONT_SIZE` → `font-size`.
pub fn word_of_tag(tag: &str) -> Option<&'static str> {
    PROPERTIES
        .iter()
        .map(|p| p.word)
        .chain(MEMBERS.iter().map(|m| m.word))
        .chain(CONTAINERS.iter().map(|c| c.word))
        .chain([SAVE_TO_FIGJAM])
        .find(|word| node_tag(word) == tag)
}

/// Where a property is legal: the members and container settings that take it.
pub fn owners(word: &str) -> Vec<&'static str> {
    MEMBERS
        .iter()
        .filter(|m| m.properties.contains(&word))
        .map(|m| m.word)
        .chain(CONTAINERS.iter().filter(|c| c.settings.contains(&word)).map(|c| c.word))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn spellings_map_to_fields_and_tags() {
        assert_eq!(field("font-size"), "fontSize");
        assert_eq!(field("show-page-tabs"), "showPageTabs");
        assert_eq!(field("layout-profile"), "layoutProfile");
        assert_eq!(field("id"), "id");
        assert_eq!(node_tag("save-to-figjam"), "SAVE_TO_FIGJAM");
        assert_eq!(word_of_tag("FONT_SIZE"), Some("font-size"));
        assert_eq!(word_of_tag("BOARD"), Some("board"));
    }

    #[test]
    fn every_word_is_defined_once() {
        let mut seen = HashSet::new();
        let words = PROPERTIES
            .iter()
            .map(|p| p.word)
            .chain(MEMBERS.iter().map(|m| m.word))
            .chain(CONTAINERS.iter().map(|c| c.word))
            .chain([SAVE_TO_FIGJAM]);
        for word in words {
            assert!(seen.insert(word), "{word} is defined twice");
        }
        let mut tags = HashSet::new();
        for set in TAG_SETS {
            for tag in set.names() {
                assert!(tags.insert(tag), "{tag} is in two tag sets");
                assert!(tag.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'), "{tag}");
            }
        }
    }

    #[test]
    fn every_legal_location_names_a_defined_word() {
        for m in &MEMBERS {
            for p in m.properties.iter().chain(m.required) {
                assert!(property(p).is_some(), "{} takes undefined {p}", m.word);
            }
            for r in m.required {
                assert!(m.properties.contains(r), "{} requires {r} but does not allow it", m.word);
            }
        }
        for c in &CONTAINERS {
            for p in c.settings.iter().chain(c.required) {
                assert!(property(p).is_some(), "{} takes undefined {p}", c.word);
            }
            for r in c.required {
                assert!(c.settings.contains(r), "{} requires {r} but does not allow it", c.word);
            }
            for child in c.children {
                assert!(member(child).is_some() || container(child).is_some(), "{} holds undefined {child}", c.word);
            }
        }
        for p in &PROPERTIES {
            assert!(!owners(p.word).is_empty(), "{} is legal nowhere", p.word);
        }
    }

    #[test]
    fn removed_words_are_not_words() {
        for word in REMOVED_GEOMETRY.iter().chain(&REMOVED_OTHER) {
            assert!(property(word).is_none() && member(word).is_none() && container(word).is_none(), "{word}");
        }
    }
}
