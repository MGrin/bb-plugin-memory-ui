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
with its full version history. Edit inline, pin what matters, and forget with a required
reason so the audit trail survives.

**Homepage section** — your pinned memories, where you'll see them.

## Why reasons are required

Agent memory only stays useful if a human can prune it, and pruning is only safe if you
can see what changed and why. Every mutation here takes a reason and writes a history
entry, matching what `bb memory forget --reason` does on the CLI rather than dropping the
record silently.

## License

MIT
