<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0184 usage guide

## Overview

L0184 makes charts: bar, line, pie (including donut and rose), scatter, histogram, box plot,
candlestick, heatmap, funnel, gauge and radar plots, drawn with Apache ECharts. Give it the numbers and what they mean — "monthly revenue and cost for Q1", "the
share of traffic by source" — and it builds one chart, or a collection of charts shown as tabs.
Data can be written inline or as a table whose columns the charts refer to by name, so several
charts can share one set of numbers. It plots only the data the request gives; it does not fetch
data from a URL or a file.

## What to ask for

- The kind of chart, if you have a preference: bars, lines, a pie or donut, a scatter, a
  histogram, box plots, candlesticks, a heatmap, a funnel, gauges or a radar chart.
- For a histogram or box plot, the raw observations — L0184 computes the bins, quartiles and
  outliers itself.
- The numbers, with their labels: categories (months, regions), series names, and values.
- Anything about presentation: titles, a second axis, stacking, horizontal bars, colours,
  a dark theme, labels on the bars, where the legend goes.
- Several views of the same data as separate charts — they appear as tabs.

## What it does not do

- It does not fetch or transform data from a URL, a file or a spreadsheet.
- Reference and trend lines, annotations, colour scales you configure yourself, network charts
  and maps are not built yet.
- It does not make spreadsheets (L0179), concept maps (L0183), Venn diagrams (L0171) or quiz
  questions (L0180).
