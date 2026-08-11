// bb-plugin-memory-ui — a browsing and curation surface for the official
// memory plugin, which ships a CLI and a settings table but no way to read what
// has accumulated.
//
// The UI is shaped by what the store actually contains, not by what the schema
// offers. Re-measured 2026-08-11 over 1,501 active records:
//   * `importance` is still noise — the migration guessed it from a use counter
//     and 91% of rows sit under 60 — so it is not shown as a badge.
//   * `kind` used to be noise too ('fact' for 100% of rows) and now is not: 120
//     records carry a real classification. It is shown when it is not 'fact'.
//   * 438 records are soft-deleted and were, until this plugin existed, invisible
//     and unrecoverable from any interface — after a bulk agent curation that is
//     the single most important thing a human needs to see.
//
// PINNING IS GONE (removed upstream on this machine 2026-08-11: "memory must be
// a self-healing and dynamic structure"). It was only ever a sort key, and a
// flag someone has to remember to tick is the opposite of self-healing. What
// replaces it is `kind = 'decision'` — a standing instruction is recognisable
// from its CONTENT, so rules and the nightly sweep can both find it without
// anyone maintaining a flag.
//
// The other half of "why would I open this?" is the Sweep view. A nightly agent
// rewrites and deletes records here; before, the only trace was a per-record
// history you had to already suspect. Sweep inverts that — it reads
// memory_history as an activity log, so what changed, who changed it, and how
// far the sweep has advanced through the backlog are all visible at once.
//
// Reads use the system `sqlite3` CLI against an immutable snapshot (no native
// dependency to rebuild against bb's embedded runtime on every app update).
// Writes go through `bb memory` — the public surface — so content guards,
// version history and optimistic concurrency apply exactly as they do to agents.
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const run = promisify(execFile);
const MEM_DB = `${os.homedir()}/.bb/plugins/memory/data.db`;

// NOT `immutable=1`. That flag promises SQLite the file can never change, and in
// exchange SQLite skips the -wal file entirely — so on a WAL database (which
// this one is) every read returns the last CHECKPOINTED state and silently
// ignores everything written since.
//
// Measured 2026-08-11: data.db checkpointed at 12:58 with a 4.4 MB -wal on top
// of it. immutable=1 counted 1,501 active records; the truth was 1,507. Three
// records forgotten and one added minutes earlier were still listed as present,
// and no error was raised anywhere — the UI simply showed a coherent, plausible,
// 45-minute-old store. That is the worst failure mode a read path can have.
//
// `mode=ro` is WAL-aware and still cannot write. The one thing it cannot do is
// CREATE the -shm file when none exists (a read-only connection may not), so if
// the database has never been opened by a writer this fails — and only then is
// the stale-but-working snapshot the better answer.
const DB_RO = `file:${MEM_DB}?mode=ro`;
const DB_STALE = `file:${MEM_DB}?immutable=1`;

/** True while the last read had to use the stale snapshot; surfaced to the UI. */
export let servingStale = false;

const q1 = (s: string) => `'${s.replace(/'/g, "''")}'`;
async function sq<T>(sql: string): Promise<T[]> {
  const exec = async (uri: string) =>
    (await run("/usr/bin/sqlite3", ["-json", uri, sql], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  let stdout: string;
  try {
    stdout = await exec(DB_RO);
    servingStale = false;
  } catch {
    // PER CALL. The first version of this latched — "fall back once, and stay
    // fallen back", to avoid re-spawning on a permanently missing -shm — and
    // that turned one transient failure into permanent silent staleness. It
    // happened within the hour: under load a single mode=ro spawn failed, the
    // plugin pinned itself to the checkpointed snapshot, and every later read
    // served ~20-minute-old data while mode=ro worked perfectly from the shell.
    //
    // Which is the exact bug this fallback was written to fix, reintroduced by
    // the fix. A stale read reports no error and looks completely healthy, so
    // it must never be something we opt into and forget. One wasted spawn on a
    // genuinely broken database is the cheaper mistake.
    stdout = await exec(DB_STALE);
    servingStale = true;
  }
  return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
}

// The memory plugin validates `kind` against this exact list — the SQLite table
// has no CHECK constraint, so reading the schema tells you nothing and writing
// an invented kind fails at the CLI. Kept in one place so the UI cannot offer a
// value the store will reject.
const KINDS = ["fact", "preference", "decision", "procedure", "episode", "reference"] as const;

const rowShape = z.object({
  id: z.string(),
  scope: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  summary: z.string(),
  kind: z.string(),
  tags: z.array(z.string()),
  importance: z.number().nullable(),
  version: z.number(),
  updatedAt: z.number().nullable(),
  accessCount: z.number(),
  lastAccessedAt: z.number().nullable(),
  deleted: z.boolean(),
  deletedAt: z.number().nullable(),
});

const listInput = z
  .object({
    scope: z.enum(["all", "global", "project"]).default("all"),
    projectId: z.string().nullable().default(null),
    q: z.string().default(""),
    // One filter instead of a row of checkboxes: each answers a real question —
    // what must survive curation (standing), what is dead weight (unused), what
    // did an agent throw away (forgotten).
    view: z.enum(["active", "standing", "unused", "forgotten"]).default("active"),
    sort: z.enum(["recent", "used", "name"]).default("recent"),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const rpcContract = defineRpcContract({
  list: { input: listInput, output: z.object({ rows: z.array(rowShape), total: z.number() }) },
  get: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({
      row: rowShape.nullable(),
      details: z.string().nullable(),
      writeReason: z.string().nullable(),
      history: z.array(
        z.object({ version: z.number(), at: z.number().nullable(), reason: z.string().nullable() }),
      ),
    }),
  },
  // Sidebar counts: the shape of the store at a glance, so navigation is a
  // click on a real number rather than a dropdown you have to guess at.
  stats: {
    input: z.null(),
    output: z.object({
      active: z.number(),
      global: z.number(),
      standing: z.number(),
      unused: z.number(),
      forgotten: z.number(),
      // Stale reads are invisible by construction — they return a complete,
      // coherent, plausible store. If we ever have to serve one, say so rather
      // than let the UI look healthy while showing yesterday.
      stale: z.boolean(),
      projects: z.array(
        z.object({ projectId: z.string(), name: z.string(), count: z.number() }),
      ),
    }),
  },

  // SWEEP. memory_history is already an append-only log of every write with its
  // reason, its author thread, and a full snapshot — but per record, so it can
  // only answer "what happened to THIS record", and only if you already suspect
  // something happened. Read across records it answers the question a human
  // actually has after an agent has been rewriting memory overnight: what
  // changed, who changed it, and is the backlog sweep actually advancing.
  sweep: {
    input: z.object({ days: z.number().int().min(1).max(90).default(14) }).strict(),
    output: z.object({
      active: z.number(),
      // Records with at least one `update` entry — and deliberately NOT called
      // "curated". A bulk backfill counts here exactly like a nightly curation
      // does, and there is no honest way to tell them apart from this table, so
      // the number claims only what it can prove: something rewrote this record
      // at least once. Calling it "curated" would have read as "the sweep is 92%
      // done" on a store where the sweep had covered maybe an eighth of it.
      // Attribution is the runs list's job, one run at a time.
      touched: z.number(),
      forgotten: z.number(),
      // Oldest `updated_at` among active records — the sweep takes the least
      // recently updated first, so this is literally where tonight starts.
      frontier: z.number().nullable(),
      runs: z.array(
        z.object({
          key: z.string(),
          threadId: z.string().nullable(),
          title: z.string().nullable(),
          startedAt: z.number(),
          endedAt: z.number(),
          creates: z.number(),
          updates: z.number(),
          forgets: z.number(),
          // The slice of the queue this run actually worked on, taken from the
          // `updatedAt` each record had BEFORE the run touched it. Consecutive
          // sweeps should show this window marching forward; if it stops, the
          // sweep is re-reading the same records and the backlog is frozen.
          queueFrom: z.number().nullable(),
          queueTo: z.number().nullable(),
        }),
      ),
    }),
  },
  // CLUSTERS — structure across records, where every other view is per record.
  //
  // This started as a duplicate finder and the measurement killed that: over
  // 1,501 real records only 2 pairs scored above 0.5 on combined name+summary
  // similarity, while the name-similar band was dominated by deliberate SERIES
  // ("VERDICT (1)" vs "VERDICT (3)", "stream B" vs "stream D") where a merge
  // would destroy information. A list that is mostly false positives is worse
  // than no list, because you stop reading it and then trust it.
  //
  // What the same data does support is narrower and much more useful: two
  // records that say nearly the same sentence with a DIFFERENT NUMBER. That is
  // not untidiness, it is the store contradicting itself, and whichever one an
  // agent recalls first wins. Found in this store on the first run: a package
  // pin recorded as both ^1.2.2 and ^1.2.3, and a claim marked "RETRACTED /
  // FALSIFIED" living alongside the original claim it falsifies.
  clusters: {
    input: z.object({ limit: z.number().int().min(1).max(100).default(40) }).strict(),
    output: z.object({
      scanned: z.number(),
      conflicts: z.array(
        z.object({
          overlap: z.number(),
          a: z.object({ id: z.string(), name: z.string(), summary: z.string(), updatedAt: z.number().nullable() }),
          b: z.object({ id: z.string(), name: z.string(), summary: z.string(), updatedAt: z.number().nullable() }),
          aOnly: z.array(z.string()),
          bOnly: z.array(z.string()),
        }),
      ),
      families: z.array(
        z.object({
          prefix: z.string(),
          count: z.number(),
          members: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
      ),
    }),
  },
  runChanges: {
    input: z
      .object({
        threadId: z.string().nullable(),
        from: z.number(),
        to: z.number(),
        limit: z.number().int().min(1).max(500).default(200),
      })
      .strict(),
    output: z.object({
      changes: z.array(
        z.object({
          memoryId: z.string(),
          name: z.string(),
          action: z.string(),
          at: z.number(),
          reason: z.string(),
          deleted: z.boolean(),
        }),
      ),
      total: z.number(),
    }),
  },
  update: {
    input: z
      .object({
        id: z.string(),
        projectId: z.string().nullable(),
        expectedVersion: z.number().int(),
        reason: z.string().min(3),
        summary: z.string().nullable().default(null),
        details: z.string().nullable().default(null),
        kind: z.enum(KINDS).nullable().default(null),
        importance: z.number().int().min(0).max(100).nullable().default(null),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  },
  forget: {
    input: z
      .object({
        id: z.string(),
        projectId: z.string().nullable(),
        expectedVersion: z.number().int(),
        reason: z.string().min(3),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  },
  // Re-scope a memory. Prefers `bb memory move` (which keeps the id, the
  // version lineage and the history) and falls back to add-then-forget on a bb
  // that does not have it yet — see the handler for why the fallback is worth
  // having rather than just refusing.
  move: {
    input: z
      .object({
        id: z.string(),
        expectedVersion: z.number().int(),
        fromProjectId: z.string().nullable(),
        toProjectId: z.string().nullable(), // null = global
        reason: z.string().min(3),
      })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      newId: z.string().nullable(),
      keptId: z.boolean(),
    }),
  },
  restore: {
    input: z.object({ id: z.string(), reason: z.string().min(3) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable(), newId: z.string().nullable() }),
  },
});

interface MemRow {
  id: string; scope: string; project_id: string | null; name: string; summary: string;
  kind: string | null; tags_json: string | null; importance: number | null; pinned: number;
  version: number; updated_at: number | null; deleted_at: number | null;
  access_count: number | null; last_accessed_at: number | null;
}

const toRow = (r: MemRow) => ({
  id: r.id,
  scope: r.scope,
  projectId: r.project_id,
  name: r.name,
  summary: r.summary,
  kind: r.kind ?? "fact",
  tags: (r.tags_json ? (JSON.parse(r.tags_json) as string[]) : []).filter((t) => t !== "paos-migrated"),
  importance: r.importance,
  version: r.version,
  updatedAt: r.updated_at,
  accessCount: r.access_count ?? 0,
  lastAccessedAt: r.last_accessed_at,
  deleted: !!r.deleted_at,
  deletedAt: r.deleted_at,
});

async function bbMemory(args: string[], projectId: string | null) {
  const env = { ...process.env, ...(projectId ? { BB_PROJECT_ID: projectId } : {}) };
  try {
    const { stdout } = await run("bb", ["memory", ...args, "--json"], { env, timeout: 30_000 });
    const parsed = JSON.parse(stdout) as { ok?: boolean; error?: string; memory?: { id?: string } };
    return {
      ok: parsed.ok !== false,
      error: parsed.ok === false ? (parsed.error ?? "unknown") : null,
      id: parsed.memory?.id ?? null,
    };
  } catch (e) {
    const msg = e instanceof Error ? (("stderr" in e && (e as { stderr?: string }).stderr) || e.message) : String(e);
    return { ok: false, error: String(msg).slice(0, 300), id: null };
  }
}

export default async function plugin(bb: BbPluginApi) {
  const titleCache = new Map<string, string | null>();

  const viewClause = (view: string) =>
    view === "forgotten"
      ? "m.deleted_at IS NOT NULL"
      : view === "standing"
        ? "m.deleted_at IS NULL AND m.kind = 'decision'"
        : view === "unused"
          // This is a DELETE-ME list, so it must not contain records that are
          // merely UNCOUNTABLE. A standing instruction is injected into an
          // agent's context rather than recalled through search, so its
          // access_count never moves — which put the production guardrail at the
          // top of this list, sorted first, inviting exactly the deletion it
          // exists to prevent (found 2026-08-10, when the exclusion was written
          // against `pinned`; pinning is gone and `kind='decision'` is what
          // identifies those records now). Zero recalls is evidence about a
          // fact. It is not evidence about an instruction.
          //
          // Records younger than a week are excluded for the same reason in a
          // different tense: nothing written last night has had a chance to be
          // used yet.
          //
          // The age test is on created_at, NOT updated_at. It was updated_at
          // until 2026-08-11, when a bulk backfill rewrote 1,469 records in an
          // afternoon and this view silently emptied — every record looked
          // "written this week". Editing a memory tells you nothing about
          // whether it has had a chance to be recalled; only its age does.
          ? "m.deleted_at IS NULL AND COALESCE(m.access_count,0) = 0 AND m.kind <> 'decision'" +
            " AND COALESCE(m.created_at,0) < (strftime('%s','now') - 7*86400) * 1000"
          : "m.deleted_at IS NULL";

  bb.rpc.register(rpcContract, {
    async list(input) {
      const where = [viewClause(input.view)];
      if (input.scope !== "all") where.push(`m.scope = ${q1(input.scope)}`);
      if (input.projectId) where.push(`m.project_id = ${q1(input.projectId)}`);
      let from = "memories m";
      const query = input.q.trim().replace(/['"]/g, "");
      if (query) {
        from = "memories_fts f JOIN memories m ON m.rowid = f.rowid";
        where.push(`memories_fts MATCH ${q1(query + "*")}`);
      }
      const w = `WHERE ${where.join(" AND ")}`;
      const order =
        input.sort === "used"
          ? "COALESCE(m.access_count,0) DESC, m.updated_at DESC"
          : input.sort === "name"
            ? "m.name COLLATE NOCASE"
            : input.view === "forgotten"
              ? "m.deleted_at DESC"
              : "m.updated_at DESC";
      // COUNT(*) OVER () rides along with the page instead of costing a second
      // process. SQLite evaluates window functions before LIMIT, so this is the
      // full filtered count, not the size of the page.
      const rows = await sq<MemRow & { total_count: number }>(
        `SELECT m.*, COUNT(*) OVER () total_count FROM ${from} ${w}
         ORDER BY ${order} LIMIT ${input.limit} OFFSET ${input.offset}`,
      );
      // An empty page carries no window value at all. That only happens past the
      // end of the list, so ask for the count directly rather than reporting 0
      // and making the pager claim the store is empty.
      if (rows.length === 0) {
        const only = await sq<{ c: number }>(`SELECT COUNT(*) c FROM ${from} ${w}`);
        return { rows: [], total: only[0]?.c ?? 0 };
      }
      return { rows: rows.map(toRow), total: rows[0].total_count };
    },

    // One process, record and history together. This is the click path — it runs
    // every time a row is opened — so a second spawn here is the one the human
    // actually waits on.
    async get({ id }) {
      const rs = await sq<
        MemRow & { details: string | null; write_reason: string | null; history_json: string | null }
      >(
        `SELECT m.*, (
            SELECT json_group_array(json_object('version', version, 'at', created_at, 'reason', write_reason))
            FROM (SELECT version, created_at, write_reason FROM memory_history
                  WHERE memory_id = ${q1(id)} ORDER BY version DESC LIMIT 20)
         ) history_json
         FROM memories m WHERE m.id = ${q1(id)}`,
      );
      const r = rs[0];
      if (!r) return { row: null, details: null, writeReason: null, history: [] };
      let history: { version: number; at: number | null; reason: string | null }[] = [];
      try {
        history = JSON.parse(r.history_json ?? "[]");
      } catch {
        history = [];
      }
      return { row: toRow(r), details: r.details, writeReason: r.write_reason, history };
    },

    async stats() {
      // ONE process, not six. Every sq() call spawns /usr/bin/sqlite3, and the
      // spawn — not the query — is the cost: measured 2026-08-11 at ~39ms each
      // idle, but this machine routinely sits at load 40+ running real work, and
      // under that the same six spawns took 1.9s while the queries themselves
      // stayed in single-digit milliseconds. Scalar subqueries collapse them all
      // into one row from one process.
      //
      // Every count still comes from viewClause, the same predicate the list
      // uses. They were separate copies until 2026-08-10, so tightening the
      // "never used" rule would have left the sidebar badge showing the old
      // number — a count that disagrees with the list it labels is worse than
      // no count at all.
      const counted = (
        await sq<{ active: number; global: number; standing: number; unused: number; forgotten: number }>(
          `SELECT
             (SELECT COUNT(*) FROM memories m WHERE ${viewClause("active")}) active,
             (SELECT COUNT(*) FROM memories m WHERE m.deleted_at IS NULL AND m.scope='global') global,
             (SELECT COUNT(*) FROM memories m WHERE ${viewClause("standing")}) standing,
             (SELECT COUNT(*) FROM memories m WHERE ${viewClause("unused")}) unused,
             (SELECT COUNT(*) FROM memories m WHERE ${viewClause("forgotten")}) forgotten`,
        )
      )[0];
      const active = counted?.active ?? 0;
      const glob = counted?.global ?? 0;
      const standing = counted?.standing ?? 0;
      const unused = counted?.unused ?? 0;
      const forgotten = counted?.forgotten ?? 0;
      const counts = await sq<{ project_id: string; c: number }>(
        `SELECT project_id, COUNT(*) c FROM memories
         WHERE deleted_at IS NULL AND project_id IS NOT NULL GROUP BY project_id ORDER BY c DESC`,
      );
      const names = new Map<string, string>();
      try {
        for (const p of await bb.sdk.projects.list({ includePersonal: true })) names.set(p.id, p.name);
      } catch {
        /* fall back to ids */
      }
      return {
        active, global: glob, standing, unused, forgotten, stale: servingStale,
        projects: counts.map((r) => ({
          projectId: r.project_id, name: names.get(r.project_id) ?? r.project_id, count: r.c,
        })),
      };
    },

    // A "run" is one thread's writes with no gap longer than RUN_GAP_MS. Grouping
    // by calendar day instead would be simpler and wrong twice: a nightly sweep
    // that starts at 23:50 gets cut in half, and an interactive thread that
    // writes a memory at breakfast and another at midnight becomes one "run"
    // spanning the day. The gap is what actually separates a batch from a batch.
    async sweep({ days }) {
      const since = Date.now() - days * 86_400_000;
      const RUN_GAP_MS = 2 * 60 * 60 * 1000;

      const entries = await sq<{
        action: string; thread_id: string | null; created_at: number; prev_updated: number | null;
      }>(
        `SELECT h.action, h.source_thread_id thread_id, h.created_at,
                json_extract(p.snapshot_json,'$.updatedAt') prev_updated
         FROM memory_history h
         LEFT JOIN memory_history p ON p.memory_id = h.memory_id AND p.version = h.version - 1
         WHERE h.created_at >= ${since}
         ORDER BY h.created_at ASC
         LIMIT 50000`,
      );

      const totals = (
        await sq<{ active: number; touched: number; forgotten: number; frontier: number | null }>(
          `SELECT
             (SELECT COUNT(*) FROM memories WHERE deleted_at IS NULL) active,
             (SELECT COUNT(*) FROM memories m WHERE m.deleted_at IS NULL AND EXISTS
                (SELECT 1 FROM memory_history h WHERE h.memory_id = m.id AND h.action = 'update')) touched,
             (SELECT COUNT(*) FROM memories WHERE deleted_at IS NOT NULL) forgotten,
             (SELECT MIN(updated_at) FROM memories WHERE deleted_at IS NULL) frontier`,
        )
      )[0];

      type Run = {
        key: string; threadId: string | null; title: string | null;
        startedAt: number; endedAt: number;
        creates: number; updates: number; forgets: number;
        queueFrom: number | null; queueTo: number | null;
      };
      const open = new Map<string, Run>();
      const runs: Run[] = [];
      for (const e of entries) {
        const tid = e.thread_id ?? "";
        let run = open.get(tid);
        if (!run || e.created_at - run.endedAt > RUN_GAP_MS) {
          run = {
            key: `${tid}:${e.created_at}`, threadId: e.thread_id, title: null,
            startedAt: e.created_at, endedAt: e.created_at,
            creates: 0, updates: 0, forgets: 0, queueFrom: null, queueTo: null,
          };
          open.set(tid, run);
          runs.push(run);
        }
        run.endedAt = e.created_at;
        if (e.action === "create") run.creates += 1;
        else if (e.action === "forget") run.forgets += 1;
        else run.updates += 1;
        // Only pre-existing records say anything about queue position: a `create`
        // has no previous version, and its own timestamp would drag the window
        // to "now" and make every run look like it had reached the front.
        if (e.prev_updated != null) {
          run.queueFrom = run.queueFrom == null ? e.prev_updated : Math.min(run.queueFrom, e.prev_updated);
          run.queueTo = run.queueTo == null ? e.prev_updated : Math.max(run.queueTo, e.prev_updated);
        }
      }

      runs.sort((a, b) => b.endedAt - a.endedAt);
      const page = runs.slice(0, 60);
      // Titles are what make a run readable — "dream — memory curation 2026-08-11"
      // versus `thr_ndhunrpsek`. Best effort per run: a thread can be archived or
      // deleted while its writes remain, and one missing title must not blank the
      // whole view.
      // Cached across calls. Without this, opening Sweep fired up to 60 internal
      // threads.get calls EVERY time — on a machine at load 40+ that alone was
      // most of the view's latency, to re-fetch titles that essentially never
      // change. A missing title is cached as null too, so a deleted thread costs
      // one lookup rather than one per render.
      await Promise.all(
        page.map(async (r) => {
          if (!r.threadId) return;
          if (titleCache.has(r.threadId)) {
            r.title = titleCache.get(r.threadId) ?? null;
            return;
          }
          try {
            // Bounded. Of 38 distinct threads in a 14-day window only 19 still
            // exist, and looking up the missing ones is what made the first load
            // of this view take 29 SECONDS — they do not fail fast. A title is a
            // nicety; the run and its counts are the content, and they are
            // already in hand. So each lookup gets 1.5s and then we move on.
            const t = (await Promise.race([
              bb.sdk.threads.get({ threadId: r.threadId }),
              new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
            ])) as { title?: string | null };
            r.title = t?.title ?? null;
          } catch {
            r.title = null;
          }
          titleCache.set(r.threadId, r.title);
        }),
      );

      return {
        active: totals?.active ?? 0,
        touched: totals?.touched ?? 0,
        forgotten: totals?.forgotten ?? 0,
        frontier: totals?.frontier ?? null,
        runs: page,
      };
    },

    async clusters({ limit }) {
      const rows = await sq<{ id: string; name: string; summary: string; updated_at: number | null }>(
        `SELECT id, name, summary, updated_at FROM memories WHERE deleted_at IS NULL`,
      );

      const STOP = new Set(
        "the a an of in on to is are and or for with by that this it as at from be was were not you your has have had its".split(" "),
      );
      const WORD = /[a-z][a-z0-9]{2,}/g;
      // Versions and multi-digit numbers only. A bare "3" is in half the store
      // and would make every pair look like a disagreement.
      const VAL = /\^?\d+\.\d+(?:\.\d+)?|\b\d{2,}\b/g;
      const words = (s: string) => new Set((s.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)));
      const vals = (s: string) => new Set(s.match(VAL) ?? []);

      // Only records that carry a value can conflict over one, and a summary of
      // four words has nothing to compare. Both filters shrink the pair space
      // far more than they cost in recall.
      const pool = rows
        .map((r) => ({ r, w: words(r.summary), v: vals(r.summary) }))
        .filter((x) => x.v.size > 0 && x.w.size >= 5);

      const index = new Map<string, number[]>();
      pool.forEach((x, i) => {
        for (const w of x.w) {
          const bucket = index.get(w);
          if (bucket) bucket.push(i);
          else index.set(w, [i]);
        }
      });

      const seen = new Set<string>();
      const conflicts: {
        overlap: number; ai: number; bi: number; aOnly: string[]; bOnly: string[];
      }[] = [];
      for (const bucket of index.values()) {
        // A word shared by 40+ records is a topic, not a coincidence, and pairing
        // every combination of them is both quadratic and meaningless.
        if (bucket.length > 40) continue;
        for (let p = 0; p < bucket.length; p += 1) {
          for (let q = p + 1; q < bucket.length; q += 1) {
            const ai = bucket[p];
            const bi = bucket[q];
            const key = `${ai}:${bi}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const A = pool[ai];
            const B = pool[bi];
            let shared = 0;
            for (const w of A.w) if (B.w.has(w)) shared += 1;
            const overlap = shared / (A.w.size + B.w.size - shared);
            if (overlap < 0.45) continue;
            const aOnly = [...A.v].filter((v) => !B.v.has(v));
            const bOnly = [...B.v].filter((v) => !A.v.has(v));
            // One side merely carrying an extra id is not a disagreement; a
            // disagreement needs each side to assert something the other does not.
            if (aOnly.length === 0 || bOnly.length === 0) continue;
            conflicts.push({ overlap: Math.round(overlap * 1000) / 1000, ai, bi, aOnly, bOnly });
          }
        }
      }
      conflicts.sort((x, y) => y.overlap - x.overlap);

      // FAMILIES are a fact about the names, not a claim about meaning — which
      // is exactly why they are safe to show where "duplicates" was not. Records
      // are named as slugs and arrive in series, so a shared 4-token prefix is
      // the store's real topology: "everything I know about flare-clients-qbo-tasks".
      const fams = new Map<string, { id: string; name: string }[]>();
      for (const r of rows) {
        const parts = r.name.split("-").filter(Boolean);
        if (parts.length < 4) continue;
        const prefix = parts.slice(0, 4).join("-");
        const bucket = fams.get(prefix);
        if (bucket) bucket.push({ id: r.id, name: r.name });
        else fams.set(prefix, [{ id: r.id, name: r.name }]);
      }
      const families = [...fams.entries()]
        .filter(([, m]) => m.length >= 4)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 30)
        .map(([prefix, m]) => ({ prefix, count: m.length, members: m.slice(0, 40) }));

      const view = (i: number) => ({
        id: pool[i].r.id, name: pool[i].r.name, summary: pool[i].r.summary, updatedAt: pool[i].r.updated_at,
      });
      return {
        scanned: rows.length,
        conflicts: conflicts.slice(0, limit).map((c) => ({
          overlap: c.overlap, a: view(c.ai), b: view(c.bi), aOnly: c.aOnly.slice(0, 4), bOnly: c.bOnly.slice(0, 4),
        })),
        families,
      };
    },

    async runChanges({ threadId, from, to, limit }) {
      const where = [`h.created_at BETWEEN ${from} AND ${to}`];
      where.push(threadId ? `h.source_thread_id = ${q1(threadId)}` : "h.source_thread_id IS NULL");
      const w = `WHERE ${where.join(" AND ")}`;
      // LEFT JOIN, and the name falls back to the snapshot: history outlives the
      // record it describes, and a change whose row is gone is exactly the change
      // you most want to still be able to read.
      const rows = await sq<{
        memory_id: string; name: string | null; action: string; at: number;
        reason: string | null; deleted: number | null;
      }>(
        `SELECT h.memory_id, COALESCE(m.name, json_extract(h.snapshot_json,'$.name')) name,
                h.action, h.created_at at, h.write_reason reason, m.deleted_at deleted
         FROM memory_history h LEFT JOIN memories m ON m.id = h.memory_id
         ${w} ORDER BY h.created_at DESC LIMIT ${limit}`,
      );
      const total = (await sq<{ c: number }>(`SELECT COUNT(*) c FROM memory_history h ${w}`))[0]?.c ?? 0;
      return {
        changes: rows.map((r) => ({
          memoryId: r.memory_id,
          name: r.name ?? r.memory_id,
          action: r.action,
          at: r.at,
          reason: r.reason ?? "",
          deleted: !!r.deleted,
        })),
        total,
      };
    },

    async update(input) {
      const args = ["update", input.id, "--expected-version", String(input.expectedVersion), "--reason", input.reason];
      if (input.summary !== null) args.push("--summary", input.summary);
      if (input.details !== null) args.push("--details", input.details);
      if (input.kind !== null) args.push("--kind", input.kind);
      if (input.importance !== null) args.push("--importance", String(input.importance));
      const res = await bbMemory(args, input.projectId);
      if (res.ok) bb.realtime.publish("memory-ui.changed", { id: input.id });
      return { ok: res.ok, error: res.error };
    },

    async forget(input) {
      const res = await bbMemory(
        ["forget", input.id, "--expected-version", String(input.expectedVersion), "--reason", input.reason],
        input.projectId,
      );
      if (res.ok) bb.realtime.publish("memory-ui.changed", { id: input.id });
      return { ok: res.ok, error: res.error };
    },

    // MOVE. Two implementations, and the difference matters enough to say in
    // the UI: the native `bb memory move` keeps the record's id, version
    // lineage and history, while the fallback cannot — it adds a copy in the
    // target scope and forgets the original, so the id changes and the history
    // stays behind on the tombstone.
    //
    // The fallback exists because the alternative is refusing to work at all on
    // every bb that predates the move command, and re-scoping is exactly the
    // repair a store needs most when it has never had the tool for it. It
    // records the old id in the new record and the new id in the forget reason,
    // so the chain stays followable — this UI linkifies mem_ ids.
    async move(input) {
      const target = input.toProjectId
        ? ["--to-project", input.toProjectId]
        : ["--to-global"];
      const native = await bbMemory(
        ["move", input.id, "--expected-version", String(input.expectedVersion),
         "--reason", input.reason, ...target],
        input.fromProjectId,
      );
      if (native.ok) {
        bb.realtime.publish("memory-ui.changed", { id: input.id });
        return { ok: true, error: null, newId: null, keptId: true };
      }
      // Only fall back for a bb that lacks the command. A version conflict or a
      // name collision is a real refusal and must not be retried as a copy —
      // that would turn "this name is taken" into two records with one name.
      if (!/unknown subcommand|unknown command/i.test(native.error ?? "")) {
        return { ok: false, error: native.error, newId: null, keptId: true };
      }

      const rows = await sq<MemRow & { details: string | null }>(
        `SELECT * FROM memories WHERE id = ${q1(input.id)} AND deleted_at IS NULL`,
      );
      const r = rows[0];
      if (!r) return { ok: false, error: "record not found", newId: null, keptId: true };

      // CHECK THE VERSION BEFORE WRITING ANYTHING. The native path gets this
      // free — the move is one transaction that either happens or does not. The
      // fallback is add-then-forget, so a stale version discovered at the forget
      // leaves the copy behind and the original alive: one fact, two records,
      // which is worse than the mis-scoping being repaired.
      //
      // Caught by its own test: on a bb without the move command every native
      // call fails with "unknown subcommand" whatever the real problem is, so a
      // deliberately stale version fell straight through the fallback and
      // duplicated the record.
      if (r.version !== input.expectedVersion) {
        return {
          ok: false,
          error: `version conflict for ${input.id}: expected ${input.expectedVersion}, current ${r.version}`,
          newId: null,
          keptId: true,
        };
      }
      const targetScopeKey = input.toProjectId ? `project:${input.toProjectId}` : "global";
      const clash = await sq<{ id: string }>(
        `SELECT id FROM memories WHERE scope_key = ${q1(targetScopeKey)}
           AND name = ${q1(r.name)} AND deleted_at IS NULL AND id <> ${q1(input.id)}`,
      );
      if (clash[0]) {
        return {
          ok: false,
          error: `a memory named "${r.name}" already exists in the target scope (${clash[0].id})`,
          newId: null,
          keptId: true,
        };
      }
      const tags = r.tags_json ? (JSON.parse(r.tags_json) as string[]) : [];
      const added = await bbMemory(
        ["add", "--scope", input.toProjectId ? "project" : "global",
         "--name", r.name, "--summary", r.summary,
         "--details", `${r.details ?? r.summary}\n\nre-scoped: was ${r.project_id ?? "global"} as ${input.id}.`,
         "--kind", r.kind ?? "fact", "--importance", String(r.importance ?? 50),
         "--reason", input.reason,
         ...tags.flatMap((t) => ["--tag", t])],
        input.toProjectId,
      );
      if (!added.ok || !added.id) {
        return { ok: false, error: added.error ?? "add failed", newId: null, keptId: false };
      }
      const forgotten = await bbMemory(
        ["forget", input.id, "--expected-version", String(input.expectedVersion),
         "--reason", `Re-scoped to ${added.id}, same content.`],
        input.fromProjectId,
      );
      bb.realtime.publish("memory-ui.changed", { id: input.id });
      if (!forgotten.ok) {
        // Say it plainly: the copy exists and the original does not know.
        return {
          ok: false,
          error: `copied to ${added.id} but the original could not be forgotten (${forgotten.error}) — both now exist`,
          newId: added.id,
          keptId: false,
        };
      }
      return { ok: true, error: null, newId: added.id, keptId: false };
    },

    // Restore re-ADDS the record through `bb memory add` rather than clearing
    // deleted_at behind the plugin's back. The CLI has no undelete, and writing
    // to another plugin's live database from outside would bypass exactly the
    // guards this UI is supposed to respect. Consequence, stated plainly in the
    // UI: the restored record gets a NEW id and starts at version 1; the
    // forgotten original stays in place as history.
    async restore({ id, reason }) {
      const rs = await sq<MemRow & { details: string | null }>(
        `SELECT * FROM memories WHERE id = ${q1(id)} AND deleted_at IS NOT NULL`,
      );
      const r = rs[0];
      if (!r) return { ok: false, error: "not a forgotten record", newId: null };
      const tags = r.tags_json ? (JSON.parse(r.tags_json) as string[]) : [];
      const args = [
        "add",
        "--scope", r.scope,
        "--name", `${r.name}`.slice(0, 64),
        "--summary", r.summary,
        "--details", r.details ?? r.summary,
        "--reason", reason,
        ...(r.kind ? ["--kind", r.kind] : []),
        ...(r.importance != null ? ["--importance", String(r.importance)] : []),
        ...tags.flatMap((t) => ["--tag", t]),
        "--tag", "restored",
      ];
      const res = await bbMemory(args, r.project_id);
      if (res.ok) bb.realtime.publish("memory-ui.changed", { id });
      return { ok: res.ok, error: res.error, newId: res.id };
    },
  });

  bb.log.info("memory-ui plugin loaded");
}
