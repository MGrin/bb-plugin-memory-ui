<!-- agents-md ceiling: 61 lines -->
# AGENTS.md — bb-plugin-memory-ui

A browsing and curation UI over bb's agent memory: search, per-record history, forget-with-
a-reason, and a **Sweep** view of what has been rewriting the store.
[`README.md`](README.md) is the user-facing document and carries the design arguments —
why there is no duplicate finder, why there is no pinning, why reasons are required. Read
it before adding a view; two obvious features were measured and deliberately not built.

## Commands, all run 2026-09-09

```sh
npm install          # rc=0
bb plugin build .    # dist/{server,app}.js + .meta.json + app.css, rc=0
```

**There is no test suite and no typecheck in this repo.** `npm test` and
`npm run typecheck` both fail with `Missing script` — `package.json` declares no `scripts`
block at all. So the whole gate is the build above plus
`.github/workflows/managed-install.yml`, which reproduces bb's managed git install
(`npm install --omit=dev --omit=optional --ignore-scripts`, then `bb plugin build`) and
asserts the six artifacts are non-empty. That workflow is the only thing standing between
a runtime import parked in `devDependencies` and every real user's install.

Adding a suite would be an improvement, not a formality: every claim in the Sweep and
Conflicts views is a computation over real history with no automated check on it.

## It reads another plugin's store

This plugin requires the official `memory` plugin and **reads its store** — it is not the
owner of that schema. A change here that assumes a column, a `kind` value or a
`memory_history` shape is coupled to a repo you do not control; verify against the
installed memory plugin rather than against this repo's expectations.

## Layout

| path | what it is |
|---|---|
| `server.ts` | every read and mutation, the FTS search, the Sweep and Conflicts queries |
| `lib/` | shared helpers for the panel |
| `app.tsx`, `components/`, `hooks/` | the panel, the record view, the homepage section |
| `components.json` | shadcn config — `components/ui/**` is generated, do not hand-edit |

## Conventions that differ from the defaults

- **Every mutation takes a reason and writes a history entry.** Matching
  `bb memory forget --reason`, not a silent delete. A path that drops a record without one
  breaks the only thing that makes pruning safe.
- **A view answers a question; it does not expose schema fields.** Standing, Unused 7d+,
  Forgotten and Sweep are named after what a human wants to know.
- **An empty list must say why it is empty.** Conflicts compares numbers, so two records
  contradicting each other in words alone will never appear — the view says so, because
  otherwise an empty list reads as "no contradictions".
- **Sweep groups runs by author and gap, never by calendar day**, which would cut a 23:50
  run in half and merge a day's scattered edits into one run that never happened.

**Nothing about who may merge, how agents are spawned, or how the maintainer's
machine handles secrets belongs in this file, and none of it is stated here.**
Those are properties of a working environment, not of this project; if you are
contributing, your own conventions apply and nothing in this repo depends on
the maintainer's.
