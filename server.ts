// bb-plugin-memory-ui — a browsing and curation surface for the official
// memory plugin, which ships a CLI and a settings table but no way to read what
// has accumulated.
//
// The UI is shaped by what the store actually contains (measured 2026-08-09 over
// 1,393 records), not by what the schema offers:
//   * `kind` is 'fact' for 100% of rows and `importance` is <60 for 91% (the
//     migration guessed it from a use counter) — both are noise as badges, so
//     neither is shown in the list.
//   * `paos-migrated` is on 81% of rows; a tag that common identifies nothing.
//   * 1,140 records have NEVER been read. That is the signal worth surfacing:
//     usage tells you what is earning its keep and what is a curation candidate.
//   * 369 records are soft-deleted and were, until now, invisible and
//     unrecoverable from any interface — after a bulk agent curation that is the
//     single most important thing a human needs to see.
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

const q1 = (s: string) => `'${s.replace(/'/g, "''")}'`;
async function sq<T>(sql: string): Promise<T[]> {
  const { stdout } = await run("/usr/bin/sqlite3", ["-json", `file:${MEM_DB}?immutable=1`, sql], {
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
}

const rowShape = z.object({
  id: z.string(),
  scope: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  importance: z.number().nullable(),
  pinned: z.boolean(),
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
    // what matters (pinned), what is dead weight (unused), what did an agent
    // throw away (forgotten).
    view: z.enum(["active", "pinned", "unused", "forgotten"]).default("active"),
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
      pinned: z.number(),
      unused: z.number(),
      forgotten: z.number(),
      projects: z.array(
        z.object({ projectId: z.string(), name: z.string(), count: z.number() }),
      ),
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
        pinned: z.boolean().nullable().default(null),
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
  tags: (r.tags_json ? (JSON.parse(r.tags_json) as string[]) : []).filter((t) => t !== "paos-migrated"),
  importance: r.importance,
  pinned: !!r.pinned,
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
  const viewClause = (view: string) =>
    view === "forgotten"
      ? "m.deleted_at IS NOT NULL"
      : view === "pinned"
        ? "m.deleted_at IS NULL AND m.pinned = 1"
        : view === "unused"
          ? "m.deleted_at IS NULL AND COALESCE(m.access_count,0) = 0"
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
              : "m.pinned DESC, m.updated_at DESC";
      const totalRows = await sq<{ c: number }>(`SELECT COUNT(*) c FROM ${from} ${w}`);
      const rows = await sq<MemRow>(
        `SELECT m.* FROM ${from} ${w} ORDER BY ${order} LIMIT ${input.limit} OFFSET ${input.offset}`,
      );
      return { rows: rows.map(toRow), total: totalRows[0]?.c ?? 0 };
    },

    async get({ id }) {
      const rs = await sq<MemRow & { details: string | null; write_reason: string | null }>(
        `SELECT * FROM memories WHERE id = ${q1(id)}`,
      );
      const r = rs[0];
      if (!r) return { row: null, details: null, writeReason: null, history: [] };
      const history = await sq<{ version: number; at: number | null; reason: string | null }>(
        `SELECT version, created_at at, write_reason reason FROM memory_history
         WHERE memory_id = ${q1(id)} ORDER BY version DESC LIMIT 20`,
      );
      return { row: toRow(r), details: r.details, writeReason: r.write_reason, history };
    },

    async stats() {
      const one = async (sql: string) => (await sq<{ c: number }>(sql))[0]?.c ?? 0;
      const [active, glob, pinned, unused, forgotten] = await Promise.all([
        one("SELECT COUNT(*) c FROM memories WHERE deleted_at IS NULL"),
        one("SELECT COUNT(*) c FROM memories WHERE deleted_at IS NULL AND scope='global'"),
        one("SELECT COUNT(*) c FROM memories WHERE deleted_at IS NULL AND pinned=1"),
        one("SELECT COUNT(*) c FROM memories WHERE deleted_at IS NULL AND COALESCE(access_count,0)=0"),
        one("SELECT COUNT(*) c FROM memories WHERE deleted_at IS NOT NULL"),
      ]);
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
        active, global: glob, pinned, unused, forgotten,
        projects: counts.map((r) => ({
          projectId: r.project_id, name: names.get(r.project_id) ?? r.project_id, count: r.c,
        })),
      };
    },

    async update(input) {
      const args = ["update", input.id, "--expected-version", String(input.expectedVersion), "--reason", input.reason];
      if (input.summary !== null) args.push("--summary", input.summary);
      if (input.details !== null) args.push("--details", input.details);
      if (input.pinned !== null) args.push("--pinned", String(input.pinned));
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
