# bb-plugin-memory-ui

A browsing and curation UI for [bb](https://getbb.app)'s agent memory.

bb's official memory plugin stores memories well and exposes a CLI, but its only UI is a
settings table — you can't search from it, you can't see a record's history, and deleting
there records no reason. This adds the surface that makes the store reviewable by a human.

```sh
bb plugin install git:https://github.com/MGrin/bb-plugin-memory-ui.git@main
```

Requires the official `memory` plugin (`bb plugin install memory`) — this reads its store.

## What it gives you

**Memory panel** — list by scope (global / project), full-text search, and a record view
with its full version history. Edit inline and forget with a required reason so the audit
trail survives. Views answer questions rather than exposing schema fields: what must
survive curation (**Standing**), what is dead weight (**Unused 7d+**), what did an agent
throw away (**Forgotten**, with one-click restore).

**Sweep** — what has been rewriting your memory. If you run a nightly curation agent, this
is the view that makes it accountable: every run, who ran it, what it rewrote, what it
merged away and into which record, and how far it has advanced through the backlog.

**Conflicts** — where the store disagrees with itself, plus the family structure of what it
knows.

**Homepage section** — your standing instructions, the records a curation pass may tighten
but must never drop.

## Sweep, and why it is the point

A memory store you only reach through search does not need a browser. What it needs is a
way to see the thing that edits it while you are not looking.

`memory_history` already records every write with its reason, its author, and a full
snapshot — but per record, so it can only answer "what happened to *this* memory", and
only if you already suspect something happened. Sweep reads it across records:

- **Runs, grouped by author and gap** — not by calendar day, which would cut a 23:50
  sweep in half and merge a day's scattered edits into one phantom "run".
- **Rewrites and deletions by default.** Curation rewrites and deletes; ordinary work only
  adds. Measured over two weeks of real history, 8 of the 10 most recent runs were an agent
  saving a single new memory — filtering by *shape* rather than size keeps those out of the
  way without hiding a one-record correction, which is worth seeing.
- **Merge targets are links.** Curation reasons name the record that kept the fact
  ("near-duplicate of `mem_…`"); clicking it opens that record, so verifying a merge is one
  click instead of a copy-paste into search.
- **A frontier and a stall check.** A backlog sweep takes the least recently updated
  records first, so the oldest `updated_at` is literally where the next run starts. If two
  consecutive sweeps do not reach further into the queue, the view says so — a sweep
  quietly re-reading the same records looks exactly like a working one from the outside.

The header count says *rewritten*, not *curated*, on purpose: a bulk backfill lands in that
number identically to a nightly curation and the store cannot tell them apart. Attribution
is the run list's job.

## Conflicts, and the duplicate finder that isn't there

This view started as a near-duplicate finder, and measuring killed that idea. Over 1,501
real records, only **two pairs** scored above 0.5 on combined name+summary similarity —
while the name-similar band was dominated by deliberate *series*: `VERDICT (1)` beside
`VERDICT (3)`, `stream B` beside `stream D`. Merging those destroys information. A list
that is mostly false positives is worse than no list, because you stop reading it and then
keep trusting it.

What the same data does support is narrower and far more useful: **two records saying
nearly the same sentence with a different number.** That is not untidiness, it is the store
contradicting itself, and whichever record an agent recalls first wins. On the first run
against a real store it found a package pin recorded as both `^1.2.2` and `^1.2.3`, and a
claim marked `RETRACTED / FALSIFIED` living alongside the original claim it falsifies —
both still active, both still recallable.

The 55%-shared-wording cut is doing real work: above it were those two genuine
contradictions, below it were two *series* — different deployments announced in the same
words. Same detector, opposite meaning, so the weaker band is shown on request rather than
mixed in.

**Families** group records by shared name prefix. Records are named as slugs and arrive in
series, so a prefix is the store's real topology — everything it knows about one subject.
Unlike "duplicates", a family is a fact about the names rather than a claim about meaning,
which is what makes it safe to show.

The detector compares **numbers**. Two records that contradict each other in words alone
("DEAD" versus "operator-approved") share no differing value and will not appear — the view
says so, because otherwise an empty list reads as "no contradictions".

## Why reasons are required

Agent memory only stays useful if a human can prune it, and pruning is only safe if you
can see what changed and why. Every mutation here takes a reason and writes a history
entry, matching what `bb memory forget --reason` does on the CLI rather than dropping the
record silently.

## On pinning

There is none, deliberately. Pinning is a flag someone has to remember to tick, which makes
it wrong by default and quietly wrong forever. Its real job — keep curation from deleting a
standing instruction — is done here by `kind = "decision"`, which is a property of what the
record *says*, so rules and agents can both recognise one without any human maintaining a
flag. The **Unused 7d+** list excludes them for the same reason it always excluded pins: a
standing instruction is injected into context rather than recalled through search, so its
recall count never moves. Zero recalls is evidence about a fact. It is not evidence about
an instruction.

## License

MIT
