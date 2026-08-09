// bb-plugin-memory-ui — a browsing/curation UI for the official memory plugin.
//
// Reads go straight to the memory plugin's SQLite (read-only; FTS included) so
// listing and search are instant and pageable. Writes go through the `bb
// memory` CLI — the stable public surface — so guards, history, and optimistic
// concurrency all apply exactly as they do for agents.
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const run = promisify(execFile);
const MEM_DB = `${os.homedir()}/.bb/plugins/memory/data.db`;

// Reads go through the system sqlite3 CLI (immutable snapshot, JSON output) —
// a native better-sqlite3 dep would need rebuilding against bb's embedded
// runtime on every bb update. Params are inlined with quote-doubling; every
// input is either an enum, a known id, or a stripped search string.
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
  kind: z.string().nullable(),
  tags: z.array(z.string()),
  importance: z.number().nullable(),
  pinned: z.boolean(),
  version: z.number(),
  updatedAt: z.number().nullable(),
  deleted: z.boolean(),
});

export const rpcContract = defineRpcContract({
  list: {
    input: z
      .object({
        scope: z.enum(["all", "global", "project"]).default("all"),
        projectId: z.string().nullable().default(null),
        q: z.string().default(""),
        pinnedOnly: z.boolean().default(false),
        includeDeleted: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
    output: z.object({ rows: z.array(rowShape), total: z.number() }),
  },
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
  projects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ projectId: z.string(), name: z.string(), count: z.number() })),
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
});

interface MemRow {
  id: string; scope: string; project_id: string | null; name: string; summary: string;
  kind: string | null; tags_json: string | null; importance: number | null; pinned: number;
  version: number; updated_at: number | null; deleted_at: number | null;
}

const toRow = (r: MemRow) => ({
  id: r.id,
  scope: r.scope,
  projectId: r.project_id,
  name: r.name,
  summary: r.summary,
  kind: r.kind,
  tags: r.tags_json ? (JSON.parse(r.tags_json) as string[]) : [],
  importance: r.importance,
  pinned: !!r.pinned,
  version: r.version,
  updatedAt: r.updated_at,
  deleted: !!r.deleted_at,
});

async function bbMemory(args: string[], projectId: string | null) {
  const env = { ...process.env, ...(projectId ? { BB_PROJECT_ID: projectId } : {}) };
  try {
    const { stdout } = await run("bb", ["memory", ...args, "--json"], { env, timeout: 30_000 });
    const parsed = JSON.parse(stdout) as { ok?: boolean; error?: string };
    return { ok: parsed.ok !== false, error: parsed.ok === false ? (parsed.error ?? "unknown") : null };
  } catch (e) {
    const msg = e instanceof Error ? (("stderr" in e && (e as { stderr?: string }).stderr) || e.message) : String(e);
    return { ok: false, error: String(msg).slice(0, 300) };
  }
}

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    async list(input) {
      const where: string[] = [];
      if (!input.includeDeleted) where.push("m.deleted_at IS NULL");
      if (input.scope !== "all") where.push(`m.scope = ${q1(input.scope)}`);
      if (input.projectId) where.push(`m.project_id = ${q1(input.projectId)}`);
      if (input.pinnedOnly) where.push("m.pinned = 1");
      let from = "memories m";
      const query = input.q.trim().replace(/['"]/g, "");
      if (query) {
        from = "memories_fts f JOIN memories m ON m.rowid = f.rowid";
        where.push(`memories_fts MATCH ${q1(query + "*")}`);
      }
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const totalRows = await sq<{ c: number }>(`SELECT COUNT(*) c FROM ${from} ${w}`);
      const rows = await sq<MemRow>(
        `SELECT m.* FROM ${from} ${w} ORDER BY m.pinned DESC, m.importance DESC, m.updated_at DESC LIMIT ${input.limit} OFFSET ${input.offset}`,
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
        `SELECT version, created_at at, write_reason reason FROM memory_history WHERE memory_id = ${q1(id)} ORDER BY version DESC LIMIT 20`,
      );
      return { row: toRow(r), details: r.details, writeReason: r.write_reason, history };
    },
    async projects() {
      const counts = await sq<{ project_id: string; c: number }>(
        `SELECT project_id, COUNT(*) c FROM memories WHERE deleted_at IS NULL AND project_id IS NOT NULL GROUP BY project_id ORDER BY c DESC`,
      );
      const names = new Map<string, string>();
      try {
        const list = await bb.sdk.projects.list({ includePersonal: true });
        for (const p of list) names.set(p.id, p.name);
      } catch {
        /* names stay as ids */
      }
      return {
        projects: counts.map((r) => ({ projectId: r.project_id, name: names.get(r.project_id) ?? r.project_id, count: r.c })),
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
      return res;
    },
    async forget(input) {
      const res = await bbMemory(
        ["forget", input.id, "--expected-version", String(input.expectedVersion), "--reason", input.reason],
        input.projectId,
      );
      if (res.ok) bb.realtime.publish("memory-ui.changed", { id: input.id });
      return res;
    },
  });

  bb.log.info("memory-ui plugin loaded");
}
