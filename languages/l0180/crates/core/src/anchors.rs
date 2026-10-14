// SPDX-License-Identifier: MIT

//! Which lists must not be randomized, which options stay put inside one
//! (`packages/core/src/anchors.ts`), and the derived option ids (`labels.ts`).

use crate::hottext::norm;
use crate::matching::parse_number;

const ANCHORS: &[&str] = &[
    "all of the above",
    "none of the above",
    "both of the above",
    "all of these",
    "none of these",
    "both of these",
    "all of the answers above",
    "none of the answers above",
];

/// True when this option reads as one that belongs last whatever else is shuffled.
pub fn is_anchored(text: &str) -> bool {
    ANCHORS.contains(&norm(text).as_str())
}

const TRUE_FALSE: &[[&str; 2]] = &[["true", "false"], ["yes", "no"]];

/// True when the list itself is ordered, so its order is information.
pub fn keeps_order(texts: &[String]) -> bool {
    if texts.len() < 2 {
        return true;
    }
    let lower: Vec<String> = texts.iter().map(|t| norm(t)).collect();
    if TRUE_FALSE.iter().any(|pair| lower.len() == 2 && lower[0] == pair[0] && lower[1] == pair[1]) {
        return true;
    }
    let Some(numbers) = texts.iter().map(|t| parse_number(t).map(|n| n.value)).collect::<Option<Vec<_>>>() else {
        return false;
    };
    let ascending = numbers.windows(2).all(|w| w[1].gt(&w[0]));
    let descending = numbers.windows(2).all(|w| w[1].lt(&w[0]));
    ascending || descending
}

/// A, B, … Z, AA, AB, …
pub fn option_label(index: usize) -> String {
    let mut n = index as i64;
    let mut out = String::new();
    loop {
        out.insert(0, char::from(b'A' + (n % 26) as u8));
        n = n / 26 - 1;
        if n < 0 {
            return out;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_run_past_z() {
        assert_eq!(option_label(0), "A");
        assert_eq!(option_label(25), "Z");
        assert_eq!(option_label(26), "AA");
        assert_eq!(option_label(27), "AB");
        assert_eq!(option_label(701), "ZZ");
        assert_eq!(option_label(702), "AAA");
    }

    #[test]
    fn ordered_lists_keep_their_order() {
        let list = |texts: &[&str]| texts.iter().map(|t| (*t).to_owned()).collect::<Vec<_>>();
        assert!(keeps_order(&list(&["2", "4", "5", "9", "11"])));
        assert!(keeps_order(&list(&["11", "9", "1/2"])));
        assert!(!keeps_order(&list(&["9", "2", "11"])));
        assert!(keeps_order(&list(&["True", "False"])));
        assert!(!keeps_order(&list(&["False", "True"])));
        assert!(!keeps_order(&list(&["1", "1"])));
        assert!(is_anchored("All of the above."));
        assert!(!is_anchored("None of these apply"));
    }
}
