<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0185 usage guide

## Overview

L0185 fetches data and reshapes it. Give it a public https URL to a JSON or CSV file — or the data
itself — and say what you want from it: which records, which fields, what to compute, how to
group, sum and sort, and what to join it with. It returns the resulting data, usually a list of
records, ready to read or to hand to another program such as a chart.

## What to ask for

- Where the data is: a public https URL, the path inside the JSON if the list is nested, or the
  values themselves.
- Which records to keep, and which fields to keep, rename or compute.
- How to group and summarize (count, total, average, …), how to sort, and how many to keep.
- What to join it with, and on which field.

## What it does not do

- It does not log in to anything or send API keys; only public https URLs are fetched, with GET.
- It does not write data anywhere.
- It does not draw charts (L0184) or build spreadsheets (L0179).
