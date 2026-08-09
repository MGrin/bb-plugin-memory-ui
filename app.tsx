// bb-plugin-memory-ui frontend — Memory nav panel + pinned homepage section.
import { useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Row = {
  id: string; scope: string; projectId: string | null; name: string; summary: string;
  kind: string | null; tags: string[]; importance: number | null; pinned: boolean;
  version: number; updatedAt: number | null; deleted: boolean;
};
type Detail = {
  row: Row | null; details: string | null; writeReason: string | null;
  history: { version: number; at: number | null; reason: string | null }[];
};

const PAGE = 50;

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{children}</span>;
}

function MemoryPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "global" | "project">("all");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ projectId: string; name: string; count: number }[]>([]);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [sel, setSel] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async (off = offset) => {
    const r = await rpc.call("list", { scope, projectId, q, pinnedOnly, includeDeleted: false, limit: PAGE, offset: off });
    setRows(r.rows as Row[]);
    setTotal(r.total);
  };
  useEffect(() => { void rpc.call("projects", null).then((p) => setProjects(p.projects)); }, []);
  useEffect(() => { setOffset(0); void load(0); }, [q, scope, projectId, pinnedOnly]);
  useRealtime("memory-ui.changed", () => { void load(); if (sel?.row) void open(sel.row.id); });

  const open = async (id: string) => setSel((await rpc.call("get", { id })) as Detail);

  const act = async (kind: "pin" | "forget" | "save", row: Row, extra?: { summary?: string; details?: string }) => {
    setBusy(row.id);
    try {
      if (kind === "forget") {
        const reason = window.prompt(`Forget "${row.name}"?\nReason (required):`);
        if (!reason) return;
        const r = await rpc.call("forget", { id: row.id, projectId: row.projectId, expectedVersion: row.version, reason });
        if (r.error) window.alert(r.error);
        else setSel(null);
      } else {
        const r = await rpc.call("update", {
          id: row.id, projectId: row.projectId, expectedVersion: row.version,
          reason: kind === "pin" ? (row.pinned ? "memory-ui: unpin" : "memory-ui: pin") : "memory-ui: manual edit",
          summary: extra?.summary ?? null, details: extra?.details ?? null,
          pinned: kind === "pin" ? !row.pinned : null, importance: null,
        });
        if (r.error) window.alert(r.error);
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search memories…"
            className="h-8 rounded-md border border-border bg-background px-2 text-sm w-56"
          />
          <select value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setProjectId(null); }}
            className="h-8 rounded-md border border-border bg-background px-1 text-sm">
            <option value="all">all scopes</option>
            <option value="global">global</option>
            <option value="project">project</option>
          </select>
          {scope !== "global" && (
            <select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value || null)}
              className="h-8 rounded-md border border-border bg-background px-1 text-sm max-w-44">
              <option value="">any project</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>{p.name} ({p.count})</option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={pinnedOnly} onChange={(e) => setPinnedOnly(e.target.checked)} /> pinned
          </label>
          <span className="text-xs text-muted-foreground ml-auto tabular-nums">{total} records</span>
        </div>
        <div className="space-y-1">
          {rows.map((r) => (
            <button key={r.id} onClick={() => void open(r.id)}
              className={`block w-full text-left rounded-md border px-3 py-2 hover:bg-accent ${sel?.row?.id === r.id ? "border-primary" : "border-border bg-card"}`}>
              <div className="flex items-center gap-2">
                {r.pinned && <span title="pinned">📌</span>}
                <span className="text-sm text-foreground truncate">{r.name}</span>
                <span className="ml-auto flex gap-1 shrink-0">
                  <Badge>{r.scope === "global" ? "global" : (projects.find((p) => p.projectId === r.projectId)?.name ?? "project")}</Badge>
                  {r.importance != null && <Badge>{r.importance}</Badge>}
                </span>
              </div>
              <div className="text-xs text-muted-foreground line-clamp-2">{r.summary}</div>
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center text-xs text-muted-foreground">
          <button disabled={offset === 0} onClick={() => { const o = Math.max(0, offset - PAGE); setOffset(o); void load(o); }}
            className="rounded border border-border px-2 py-1 disabled:opacity-40">← prev</button>
          <span>{offset + 1}–{Math.min(offset + PAGE, total)}</span>
          <button disabled={offset + PAGE >= total} onClick={() => { const o = offset + PAGE; setOffset(o); void load(o); }}
            className="rounded border border-border px-2 py-1 disabled:opacity-40">next →</button>
        </div>
      </div>
      {sel?.row && (
        <DetailPane sel={sel} busy={busy === sel.row.id} onClose={() => setSel(null)} onAct={act} />
      )}
    </div>
  );
}

function DetailPane({ sel, busy, onClose, onAct }: {
  sel: Detail; busy: boolean; onClose: () => void;
  onAct: (k: "pin" | "forget" | "save", row: Row, extra?: { summary?: string; details?: string }) => Promise<void>;
}) {
  const row = sel.row!;
  const [summary, setSummary] = useState(row.summary);
  const [details, setDetails] = useState(sel.details ?? "");
  useEffect(() => { setSummary(row.summary); setDetails(sel.details ?? ""); }, [row.id, row.version]);
  const dirty = summary !== row.summary || details !== (sel.details ?? "");
  return (
    <div className="w-[380px] shrink-0 border-l border-border overflow-y-auto p-4 space-y-3 bg-card">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground truncate">{row.name}</span>
        <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground">✕</button>
      </div>
      <div className="flex gap-1 flex-wrap">
        <Badge>v{row.version}</Badge>
        <Badge>{row.scope}</Badge>
        {row.kind && <Badge>{row.kind}</Badge>}
        {row.tags.map((t) => <Badge key={t}>{t}</Badge>)}
      </div>
      <label className="block text-xs text-muted-foreground">summary
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4}
          className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm" />
      </label>
      <label className="block text-xs text-muted-foreground">details
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={10}
          className="mt-1 w-full rounded-md border border-border bg-background p-2 text-xs font-mono" />
      </label>
      <div className="flex gap-2">
        <button disabled={!dirty || busy}
          onClick={() => void onAct("save", row, { summary: summary !== row.summary ? summary : undefined, details: details !== (sel.details ?? "") ? details : undefined })}
          className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm disabled:opacity-40">Save</button>
        <button disabled={busy} onClick={() => void onAct("pin", row)}
          className="rounded-md border border-border px-3 py-1.5 text-sm">{row.pinned ? "Unpin" : "Pin"}</button>
        <button disabled={busy} onClick={() => void onAct("forget", row)}
          className="rounded-md border border-destructive text-destructive px-3 py-1.5 text-sm ml-auto">Forget…</button>
      </div>
      {sel.writeReason && <div className="text-xs text-muted-foreground">last write: {sel.writeReason}</div>}
      {sel.history.length > 0 && (
        <div className="text-xs text-muted-foreground space-y-1">
          <div className="font-medium">history</div>
          {sel.history.map((h) => (
            <div key={h.version}>v{h.version} · {h.at ? new Date(h.at).toISOString().slice(0, 16) : "?"} · {h.reason ?? ""}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function PinnedSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    void rpc.call("list", { scope: "all", projectId: null, q: "", pinnedOnly: true, includeDeleted: false, limit: 6, offset: 0 })
      .then((r) => setRows(r.rows as Row[]));
  }, []);
  if (!rows.length) return null;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.id} className="rounded-md border border-border bg-card px-3 py-2">
          <div className="text-sm text-foreground">📌 {r.name}</div>
          <div className="text-xs text-muted-foreground line-clamp-2">{r.summary}</div>
        </div>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "memory", title: "Memory", icon: "Brain", path: "memory", component: MemoryPanel });
  app.slots.homepageSection({ id: "pinned-memories", title: "Pinned memories", component: PinnedSection });
});
