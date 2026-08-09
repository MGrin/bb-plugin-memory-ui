// bb-plugin-memory-ui frontend — Memory panel + pinned homepage section.
//
// Designed against the store's real shape: ~1,400 records, one kind, importance
// mostly meaningless, 80% sharing one tag, and most never read. So the list
// shows identity + usage and nothing else, navigation is a keyboard away, and
// the views answer questions ("what is dead weight?", "what did an agent throw
// away?") instead of exposing schema fields.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Row = {
  id: string; scope: string; projectId: string | null; name: string; summary: string;
  tags: string[]; importance: number | null; pinned: boolean; version: number;
  updatedAt: number | null; accessCount: number; lastAccessedAt: number | null;
  deleted: boolean; deletedAt: number | null;
};
type Detail = {
  row: Row | null; details: string | null; writeReason: string | null;
  history: { version: number; at: number | null; reason: string | null }[];
};
type Stats = {
  active: number; global: number; pinned: number; unused: number; forgotten: number;
  projects: { projectId: string; name: string; count: number }[];
};
type View = "active" | "pinned" | "unused" | "forgotten";
type Sort = "recent" | "used" | "name";

const PAGE = 50;

/** "3d ago" beats an ISO timestamp when scanning a list. */
function ago(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.round(s / 86400)}d ago`;
  return `${Math.round(s / 2592000)}mo ago`;
}

function SideItem(props: { label: string; count?: number; active: boolean; onClick: () => void; muted?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
        props.active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      <span className={`truncate ${props.muted ? "italic" : ""}`}>{props.label}</span>
      {props.count !== undefined && (
        <span className="ml-auto shrink-0 tabular-nums text-xs opacity-70">{props.count}</span>
      )}
    </button>
  );
}

function MemoryPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("active");
  const [sort, setSort] = useState<Sort>("recent");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [scope, setScope] = useState<"all" | "global" | "project">("all");
  const [offset, setOffset] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (off = offset) => {
      const r = await rpc.call("list", { scope, projectId, q, view, sort, limit: PAGE, offset: off });
      setRows(r.rows as Row[]);
      setTotal(r.total);
      setCursor((c) => Math.min(c, Math.max(0, (r.rows as Row[]).length - 1)));
    },
    [scope, projectId, q, view, sort, offset],
  );
  const refreshStats = useCallback(async () => setStats((await rpc.call("stats", null)) as Stats), []);

  useEffect(() => { void refreshStats(); }, []);
  useEffect(() => { setOffset(0); void load(0); }, [q, view, sort, scope, projectId]);
  useRealtime("memory-ui.changed", () => { void load(); void refreshStats(); });

  const open = useCallback(async (id: string) => setSel((await rpc.call("get", { id })) as Detail), []);
  const say = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 4000); };

  // Keyboard: 1,400 records is too many to mouse through. j/k move, Enter opens,
  // / focuses search, Esc closes — the bindings a list like this should have.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA";
      if (e.key === "/" && !typing) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === "Escape") { if (typing) (document.activeElement as HTMLElement).blur(); else setSel(null); return; }
      if (typing) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
      if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
      if (e.key === "Enter" && rows[cursor]) { e.preventDefault(); void open(rows[cursor].id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, open]);

  const act = async (kind: "pin" | "save" | "forget" | "restore", row: Row, extra?: { summary?: string; details?: string }) => {
    setBusy(true);
    try {
      if (kind === "forget") {
        const reason = window.prompt(`Forget "${row.name}"?\n\nIt becomes a soft delete — you can restore it from the Forgotten view.\n\nReason:`);
        if (!reason) return;
        const r = await rpc.call("forget", { id: row.id, projectId: row.projectId, expectedVersion: row.version, reason });
        r.error ? say(`Failed: ${r.error}`) : (setSel(null), say("Forgotten — find it under Forgotten to restore"));
      } else if (kind === "restore") {
        const r = await rpc.call("restore", { id: row.id, reason: "restored from the Forgotten view" });
        r.error ? say(`Failed: ${r.error}`) : (setSel(null), say("Restored as a new record (new id, version 1)"));
      } else {
        const r = await rpc.call("update", {
          id: row.id, projectId: row.projectId, expectedVersion: row.version,
          reason: kind === "pin" ? (row.pinned ? "memory-ui: unpin" : "memory-ui: pin") : "memory-ui: manual edit",
          summary: extra?.summary ?? null, details: extra?.details ?? null,
          pinned: kind === "pin" ? !row.pinned : null, importance: null,
        });
        if (r.error) say(`Failed: ${r.error}`);
        else if (kind === "save") say("Saved");
      }
      await load();
      await refreshStats();
    } finally {
      setBusy(false);
    }
  };

  const projName = (id: string | null) =>
    id ? (stats?.projects.find((p) => p.projectId === id)?.name ?? "project") : "global";

  return (
    <div className="flex h-full">
      {/* Sidebar: the shape of the store, as clickable numbers. */}
      <div className="w-52 shrink-0 border-r border-border overflow-y-auto p-2 space-y-3">
        <div className="space-y-0.5">
          <SideItem label="All memories" count={stats?.active} active={view === "active" && !projectId && scope === "all"}
            onClick={() => { setView("active"); setProjectId(null); setScope("all"); }} />
          <SideItem label="Pinned" count={stats?.pinned} active={view === "pinned"} onClick={() => setView("pinned")} />
          <SideItem label="Never used" count={stats?.unused} active={view === "unused"} onClick={() => setView("unused")} />
          <SideItem label="Forgotten" count={stats?.forgotten} active={view === "forgotten"} onClick={() => setView("forgotten")} muted />
        </div>
        <div className="space-y-0.5">
          <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">Scope</div>
          <SideItem label="Global" count={stats?.global} active={scope === "global"}
            onClick={() => { setScope(scope === "global" ? "all" : "global"); setProjectId(null); setView("active"); }} />
          {stats?.projects.map((p) => (
            <SideItem key={p.projectId} label={p.name} count={p.count} active={projectId === p.projectId}
              onClick={() => { setProjectId(projectId === p.projectId ? null : p.projectId); setScope("all"); setView("active"); }} />
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        <div className="flex items-center gap-2">
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search…  (press / )"
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm" />
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}
            className="h-8 rounded-md border border-border bg-background px-1 text-xs">
            <option value="recent">recent</option>
            <option value="used">most used</option>
            <option value="name">name</option>
          </select>
        </div>

        {view === "forgotten" && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Soft-deleted records, newest first — including everything the nightly curation removed.
            Restore re-adds the content as a <strong>new record</strong> (new id, version 1); the original stays here as history.
          </div>
        )}

        {rows.length === 0 && (
          <div className="px-2 py-8 text-center text-sm text-muted-foreground">
            {q ? `Nothing matches “${q}”.` : "Nothing here."}
          </div>
        )}

        <div className="space-y-1">
          {rows.map((r, i) => (
            <button key={r.id} onClick={() => { setCursor(i); void open(r.id); }}
              className={`block w-full rounded-md border px-3 py-2 text-left hover:bg-accent ${
                sel?.row?.id === r.id ? "border-primary" : i === cursor ? "border-border bg-accent/40" : "border-border bg-card"
              }`}>
              <div className="flex items-center gap-2">
                {r.pinned && <span title="pinned">📌</span>}
                <span className={`truncate text-sm ${r.deleted ? "text-muted-foreground line-through" : "text-foreground"}`}>
                  {r.name}
                </span>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {r.deleted
                    ? `forgotten ${ago(r.deletedAt)}`
                    : r.accessCount > 0
                      ? `used ${r.accessCount}× · ${ago(r.lastAccessedAt)}`
                      : "never used"}
                </span>
              </div>
              <div className="line-clamp-2 text-xs text-muted-foreground">{r.summary}</div>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <button disabled={offset === 0} onClick={() => { const o = Math.max(0, offset - PAGE); setOffset(o); void load(o); }}
            className="rounded border border-border px-2 py-1 disabled:opacity-40">← prev</button>
          <span>{total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
          <button disabled={offset + PAGE >= total} onClick={() => { const o = offset + PAGE; setOffset(o); void load(o); }}
            className="rounded border border-border px-2 py-1 disabled:opacity-40">next →</button>
          <span className="ml-auto opacity-60">j/k move · enter open · / search · esc close</span>
        </div>
      </div>

      {sel?.row && (
        <DetailPane sel={sel} busy={busy} projectLabel={projName(sel.row.projectId)}
          onClose={() => setSel(null)} onAct={act} />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function DetailPane({ sel, busy, projectLabel, onClose, onAct }: {
  sel: Detail; busy: boolean; projectLabel: string; onClose: () => void;
  onAct: (k: "pin" | "save" | "forget" | "restore", row: Row, extra?: { summary?: string; details?: string }) => Promise<void>;
}) {
  const row = sel.row!;
  const [summary, setSummary] = useState(row.summary);
  const [details, setDetails] = useState(sel.details ?? "");
  useEffect(() => { setSummary(row.summary); setDetails(sel.details ?? ""); }, [row.id, row.version]);
  const dirty = summary !== row.summary || details !== (sel.details ?? "");

  return (
    <div className="w-[400px] shrink-0 overflow-y-auto border-l border-border bg-card p-4 space-y-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{row.name}</div>
          <div className="text-xs text-muted-foreground">
            {projectLabel} · v{row.version} ·{" "}
            {row.deleted ? `forgotten ${ago(row.deletedAt)}` : row.accessCount > 0 ? `used ${row.accessCount}×` : "never used"}
          </div>
        </div>
        <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground">✕</button>
      </div>

      {row.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {row.tags.map((t) => (
            <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t}</span>
          ))}
        </div>
      )}

      {row.deleted ? (
        <>
          <div className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
            {sel.writeReason ? <>Forgotten because: <em>{sel.writeReason}</em></> : "Forgotten."}
          </div>
          <div className="whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-xs">{sel.details ?? row.summary}</div>
          <button disabled={busy} onClick={() => void onAct("restore", row)}
            className="w-full rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40">
            Restore this memory
          </button>
        </>
      ) : (
        <>
          <label className="block text-xs text-muted-foreground">summary
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4}
              className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm" />
          </label>
          <label className="block text-xs text-muted-foreground">details
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={12}
              className="mt-1 w-full rounded-md border border-border bg-background p-2 font-mono text-xs" />
          </label>
          <div className="flex gap-2">
            <button disabled={!dirty || busy}
              onClick={() => void onAct("save", row, {
                summary: summary !== row.summary ? summary : undefined,
                details: details !== (sel.details ?? "") ? details : undefined,
              })}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40">Save</button>
            <button disabled={busy} onClick={() => void onAct("pin", row)}
              className="rounded-md border border-border px-3 py-1.5 text-sm">{row.pinned ? "Unpin" : "Pin"}</button>
            <button disabled={busy} onClick={() => void onAct("forget", row)}
              className="ml-auto rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive">Forget…</button>
          </div>
        </>
      )}

      {sel.history.length > 0 && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="font-medium">history</div>
          {sel.history.map((h) => (
            <div key={h.version} className="truncate">v{h.version} · {ago(h.at)} · {h.reason ?? ""}</div>
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
    void rpc.call("list", { scope: "all", projectId: null, q: "", view: "pinned", sort: "recent", limit: 6, offset: 0 })
      .then((r) => setRows(r.rows as Row[]));
  }, []);
  if (!rows.length) return null;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.id} className="rounded-md border border-border bg-card px-3 py-2">
          <div className="text-sm text-foreground">📌 {r.name}</div>
          <div className="line-clamp-2 text-xs text-muted-foreground">{r.summary}</div>
        </div>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "memory", title: "Memory", icon: "Brain", path: "memory", component: MemoryPanel });
  app.slots.homepageSection({ id: "pinned-memories", title: "Pinned memories", component: PinnedSection });
});
