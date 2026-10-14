// SPDX-License-Identifier: MIT

//! The collection (`packages/core/src/collection.ts`): every program is one
//! `charts [ … ] settings {}`, even with a single chart. Charts keep source order; ids default
//! to c1, c2, …; names default to ids; tabs show once there are two or more; the menu is off
//! unless asked for. The envelope always carries `type`, `charts` and a complete `view`.

use crate::chart::{Look, build_chart};
use crate::colors::{resolve_color, resolve_colors};
use crate::data::scope_datasets;
use crate::js::{Js, stringify};
use crate::obj;

pub fn build_collection(datasets: Option<&Js>, charts: &[Js], settings: &Js) -> Result<Js, String> {
    let shared_items = match datasets {
        Some(d) if !d.is_nullish() => d.prop("items")?.as_arr().cloned().unwrap_or_default(),
        _ => Vec::new(),
    };
    let shared = scope_datasets(&shared_items, "charts datasets")?;
    let palette = match settings.get("palette") {
        Js::Undefined => None,
        p => Some(resolve_colors(p, "charts palette")?),
    };
    let background = match settings.get("background") {
        Js::Undefined => None,
        b => Some(resolve_color(b, "charts background")?),
    };

    let mut ids: Vec<Js> = Vec::with_capacity(charts.len());
    for (i, c) in charts.iter().enumerate() {
        ids.push(c.prop("settings")?.prop("id")?.or(Js::Str(format!("c{}", i + 1))));
    }
    for (i, id) in ids.iter().enumerate() {
        let j = ids.iter().position(|other| crate::js::strict_eq(other, id)).unwrap_or(i);
        if j != i {
            return Err(format!(
                "charts: charts {} and {} both have the id {}. Ids pick a chart's tab, so give each chart its own id.",
                j + 1,
                i + 1,
                stringify(id)
            ));
        }
    }

    let n = charts.len();
    let show_tabs = settings.get("showChartTabs").or(Js::Bool(n >= 2));
    let show_menu = settings.get("showChartMenu").or(Js::Bool(false));
    let hide_menu = !show_menu.truthy();
    if n > 1 && !show_tabs.truthy() && !show_menu.truthy() {
        return Err("charts: `show-chart-tabs false` without `show-chart-menu true` leaves no way to reach any chart but the first. Keep the tabs, or add show-chart-menu true.".to_owned());
    }

    let look = Look { palette, background: background.clone() };
    let mut built = Vec::with_capacity(n);
    for (i, c) in charts.iter().enumerate() {
        let id = &ids[i];
        let name = c.prop("settings")?.get("name").or(id.clone());
        built.push(build_chart(c, id, &name, &format!("chart {}", stringify(id)), &shared, &look)?);
    }

    let mut view = obj! {
        "theme" => if settings.get("theme").as_str() == Some("DARK") { "dark" } else { "light" },
        "renderer" => "canvas",
        "locale" => "EN",
        "showTabs" => show_tabs,
        "hideMenu" => hide_menu,
    };
    if !settings.get("title").is_undefined() {
        view.insert("title".into(), settings.get("title").clone());
    }
    if !settings.get("instructions").is_undefined() {
        view.insert("instructions".into(), settings.get("instructions").clone());
    }
    if let Some(background) = background.filter(|b| !b.is_empty()) {
        view.insert("background".into(), Js::Str(background));
    }
    Ok(Js::Obj(obj! { "type" => "charts", "charts" => Js::Arr(built), "view" => view }))
}
