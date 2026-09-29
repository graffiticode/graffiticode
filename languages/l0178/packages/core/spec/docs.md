<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0178 User Manual

**Introduction**

*Graffiticode* is a collection of domain languages used for creating task
specific web apps. **L0178** is a *Graffiticode* language that produces developer
cookbook recipes for the **Learnosity Data API** — the server-to-server interface
to a Learnosity item bank.

L0178 is an empirical integration oracle. When handling a recipe request it never calls the Data API: the caller's own code
signs and sends every request with the caller's own consumer key. What L0178
supplies is the published documentation plus the un-written tricks and tips.

### Evidence and verification contract

- **[documented]**: an expectation from the published reference, not a live observation.
- **[schema-confirmed]**: an identifier or structure checked against a published schema, not a behavioral test.
- **[verified] / empirically observed**: the specific behavior was exercised end to end in the stated environment. This label does not cover the entire endpoint or every supported option.
- **Verified in this deployment**: the caller actually ran the relevant checks in their deployment. Neither compilation nor a complete design establishes this.

For each measured claim, record the behavior and inputs exercised, the procedure and meaningful control where applicable, expected and observed outcomes, date, environment, API/SDK versions, and limits. Link an existing experiment record when available. If provenance is missing, say so; do not invent it or promote a documentation claim. Keep modeled coverage separate from empirical coverage. Generated recipes must preserve the evidence behind consequential claims and the checks still required of the caller.


### Status

**Early.** Thirty of the Data API's 57 operations are modelled, spanning every structural
shape the API has: paged and unpaged reads, synchronous and asynchronous work, writes that
replace and writes that merge, a destructive delete, and an endpoint whose two operations are
told apart by a field value.

Coverage is uneven on purpose, and `coverage.md` says which is which. Specific Item bank and jobs behaviors have been observed against live consumers; observations do not verify every field or operation. The session submissions, the
delete, and six of the eight updates are modelled from documentation only — the delete
deliberately, since running it destroys a session irreversibly.

### Vocabulary

A program is one `data-job` head carrying a paging policy and exactly one block, terminated
with `{}` then `..`.

| Function | Arity | Example | Description |
| :------- | :---: | :------ | :---------- |
| **data-job** | 1 | `data-job … {}..` | The head; carries the policy and the block |
| **a block** | 2 | `items-get [ … ]` | Selects the operation — see `spec.md` for the index |
| **paging** | 2 | `paging EXHAUSTIVE` | `EXHAUSTIVE` or `SINGLE-PAGE`; design intent only |

`spec.md` lists every block; `instructions.md` gives each one's request fields. They are not
repeated here, because a third copy would be a third thing to keep in step.
