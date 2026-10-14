// SPDX-License-Identifier: MIT

//! Colours (`packages/core/src/colors.ts`): a Tailwind v3 token ("blue-500") or a hex code
//! ("#3b82f6", "#38f", "#3b82f680"). Anything else is a compile error. The token table is
//! read from `colors.ts` into `vocab.json`.

use crate::js::{Js, quote, trim};
use crate::vocab::VOCAB;

fn is_hex(token: &str) -> bool {
    token
        .strip_prefix('#')
        .is_some_and(|hex| matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Resolves a colour to hex, or says what was written and where.
pub fn resolve_color(raw: &Js, place: &str) -> Result<String, String> {
    let token = match raw {
        Js::Str(s) if !trim(s).is_empty() => trim(s),
        _ => {
            return Err(format!(
                "{place}: expected a colour in \"quotes\" — a Tailwind token like \"blue-500\" or a hex code like \"#3b82f6\"."
            ));
        }
    };
    if is_hex(token) {
        return Ok(token.to_ascii_lowercase());
    }
    if let Some(hex) = VOCAB.tailwind.get(&token.to_lowercase()) {
        return Ok(hex.clone());
    }
    Err(format!(
        "{place}: {} is not a colour. Use a Tailwind token like \"blue-500\" (shades 50–950) or a hex code like \"#3b82f6\".",
        quote(token)
    ))
}

pub fn resolve_colors(raw: &Js, place: &str) -> Result<Vec<String>, String> {
    match raw {
        Js::Arr(items) if !items.is_empty() => {
            items.iter().enumerate().map(|(i, c)| resolve_color(c, &format!("{place} colour {}", i + 1))).collect()
        }
        _ => Err(format!("{place}: expected a list of colours in [brackets], e.g. [\"blue-500\" \"amber-500\"].")),
    }
}
