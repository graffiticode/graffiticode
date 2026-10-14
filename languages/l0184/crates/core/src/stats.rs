// SPDX-License-Identifier: MIT

//! Statistics computed at compile time (`packages/core/src/stats.ts`). Pure, and every
//! function handles empty input before applying a formula. Numbers are JavaScript doubles
//! throughout; labels are written as `String(Number(x.toPrecision(p)))` writes them.

use crate::js::num;

/// Sturges' rule: `ceil(log2(n) + 1)` bins for n ≥ 1 observations.
pub fn sturges(n: usize) -> f64 {
    ((n as f64).log2() + 1.0).ceil()
}

/// `x.toPrecision(p)`, read back as a number and written as JavaScript writes numbers.
pub fn sig(x: f64, p: usize) -> String {
    num(to_precision(x, p))
}

/// `Number(x.toPrecision(p))`: `x` rounded half up to `p` significant digits of its exact
/// decimal value.
pub fn to_precision(x: f64, p: usize) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return x;
    }
    // Every digit of the double's exact decimal expansion (at most 767 are significant).
    let exact = format!("{:.800e}", x.abs());
    let (mantissa, exponent) = exact.split_once('e').expect("exponential form");
    let mut exponent: i32 = exponent.parse().expect("an exponent");
    let digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).map(|b| b - b'0').collect();
    let mut kept: Vec<u8> = digits[..p].to_vec();
    if digits[p] >= 5 {
        let mut i = p;
        loop {
            if i == 0 {
                kept.insert(0, 1);
                kept.pop();
                exponent += 1;
                break;
            }
            i -= 1;
            if kept[i] == 9 {
                kept[i] = 0;
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let text: String = kept.iter().map(|d| char::from(b'0' + d)).collect();
    let value: f64 = format!("0.{text}e{}", exponent + 1).parse().expect("a number");
    if x < 0.0 { -value } else { value }
}

/// Edge labels at the fewest significant digits (at least 3) that keep every adjacent pair of
/// edges distinct, so no two bins read the same.
pub fn edge_labels(edges: &[f64]) -> Vec<String> {
    for p in 3..=17 {
        let out: Vec<String> = edges.iter().map(|&e| sig(e, p)).collect();
        if out.windows(2).all(|pair| pair[0] != pair[1]) {
            return out;
        }
    }
    edges.iter().map(|&e| num(e)).collect()
}

pub struct Bins {
    pub labels: Vec<String>,
    pub counts: Vec<f64>,
}

/// Equal-width bins over [min, max]: each bin is `[lower, upper)`, and the last is
/// `[lower, max]`, so the maximum is counted. Constant data is one bin labelled with its value.
pub fn histogram(values: &[f64], bin_count: Option<f64>) -> Bins {
    let n = values.len();
    if n == 0 {
        return Bins { labels: Vec::new(), counts: Vec::new() };
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for &v in values {
        if v < min {
            min = v;
        }
        if v > max {
            max = v;
        }
    }
    if min == max {
        return Bins { labels: vec![sig(min, 3)], counts: vec![n as f64] };
    }
    let k = bin_count.unwrap_or_else(|| sturges(n));
    let width = (max - min) / k;
    let bins = k as usize;
    let edges: Vec<f64> = (0..=bins).map(|i| if i == bins { max } else { min + i as f64 * width }).collect();
    let mut counts = vec![0.0; bins];
    for &v in values {
        let at = ((v - min) / width).floor();
        // `counts[NaN]++` sets a property no one reads: the value is not counted.
        if at.is_nan() {
            continue;
        }
        let mut i = (bins as f64 - 1.0).min(at) as usize;
        // Floating-point can put a value a bin off at an edge; settle it against the edges.
        while i > 0 && v < edges[i] {
            i -= 1;
        }
        while i < bins - 1 && v >= edges[i + 1] {
            i += 1;
        }
        counts[i] += 1.0;
    }
    let e = edge_labels(&edges);
    Bins { labels: (0..bins).map(|i| format!("{}–{}", e[i], e[i + 1])).collect(), counts }
}

/// The R-7 (linear interpolation) quantile of sorted values.
pub fn quantile_r7(sorted: &[f64], p: f64) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return f64::NAN;
    }
    let h = (n - 1) as f64 * p;
    let lo = h.floor();
    let hi = h.ceil();
    sorted[lo as usize] + (h - lo) * (sorted[hi as usize] - sorted[lo as usize])
}

pub struct BoxStats {
    pub r#box: Option<[f64; 5]>,
    pub outliers: Vec<f64>,
}

/// `[lowWhisker, q1, median, q3, highWhisker]`, with R-7 quartiles and whiskers at the most
/// extreme observed values within 1.5×IQR of the quartiles; everything beyond is an outlier.
pub fn boxplot(values: &[f64]) -> BoxStats {
    if values.is_empty() {
        return BoxStats { r#box: None, outliers: Vec::new() };
    }
    let mut sorted = values.to_vec();
    // `sort((a, b) => a - b)`: stable, and -0 and 0 compare equal.
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let q1 = quantile_r7(&sorted, 0.25);
    let median = quantile_r7(&sorted, 0.5);
    let q3 = quantile_r7(&sorted, 0.75);
    let iqr = q3 - q1;
    let low_fence = q1 - 1.5 * iqr;
    let high_fence = q3 + 1.5 * iqr;
    let inside: Vec<f64> = sorted.iter().copied().filter(|&v| v >= low_fence && v <= high_fence).collect();
    let outliers: Vec<f64> = sorted.iter().copied().filter(|&v| v < low_fence || v > high_fence).collect();
    // An empty `inside` reads `undefined` in JavaScript, which is `null` in JSON.
    let first = inside.first().copied().unwrap_or(f64::NAN);
    let last = inside.last().copied().unwrap_or(f64::NAN);
    BoxStats { r#box: Some([first, q1, median, q3, last]), outliers }
}

/// The smallest number of the form 1, 2 or 5 × 10ⁿ (integer n) that is at least x, for x > 0.
/// Infinity when none is representable.
pub fn nice_ceil(x: f64) -> f64 {
    if !(x > 0.0) || !x.is_finite() {
        return f64::INFINITY;
    }
    let n = x.log10().floor();
    for e in [n - 1.0, n, n + 1.0] {
        for m in [1.0, 2.0, 5.0] {
            let c = m * 10f64.powf(e);
            if c >= x && c.is_finite() {
                return c;
            }
        }
    }
    f64::INFINITY
}

/// A finite, nondegenerate range around a constant value v.
pub fn constant_range(v: f64) -> (f64, f64) {
    let pad = (v.abs() / 2.0).max(1.0);
    ((v - pad).max(-f64::MAX), (v + pad).min(f64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precision_rounds_half_up_on_the_exact_value() {
        assert_eq!(sig(0.125, 2), "0.13");
        assert_eq!(sig(0.375, 2), "0.38");
        assert_eq!(sig(2.5, 1), "3");
        assert_eq!(sig(-2.5, 1), "-3");
        // 1.005 is just below 1.005 as a double.
        assert_eq!(sig(1.005, 3), "1");
        assert_eq!(sig(9.995, 3), "9.99");
        assert_eq!(sig(9.9999, 3), "10");
        assert_eq!(sig(123456789.0, 3), "123000000");
        assert_eq!(sig(1e-7, 3), "1e-7");
        assert_eq!(sig(0.30000000000000004, 17), "0.30000000000000004");
    }

    #[test]
    fn histograms_count_every_value_once() {
        let bins = histogram(&[1.0, 2.0, 2.0, 3.0, 7.0, 9.0, 12.0], None);
        assert_eq!(bins.counts.iter().sum::<f64>(), 7.0);
        assert_eq!(bins.labels[0], "1–3.75");
        let constant = histogram(&[5.0, 5.0], None);
        assert_eq!((constant.labels, constant.counts), (vec!["5".to_owned()], vec![2.0]));
    }

    #[test]
    fn round_maxima() {
        assert_eq!(nice_ceil(3.0), 5.0);
        assert_eq!(nice_ceil(10.0), 10.0);
        assert_eq!(nice_ceil(0.03), 0.05);
        assert_eq!(nice_ceil(f64::MAX), f64::INFINITY);
    }
}
