// bb-plugin-memory-ui frontend — Memory panel (browse + curate) and Sweep
// (what has been rewriting the store).
//
// Designed against the store's real shape: ~1,500 records, importance mostly
// meaningless, most never recalled. So the list shows identity + usage and
// nothing else, navigation is a keyboard away, and the views answer questions
// ("what must survive curation?", "what is dead weight?", "what did an agent
// throw away?") instead of exposing schema fields.
//
// Sweep exists because the honest answer to "why would I ever open this?" was
// not browsing — a store you only read through search does not need a browser.
// It is that an agent rewrites and deletes records here every night, and until
// now the only trace was a per-record history you had to already suspect.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Row = {
  id: string; scope: string; projectId: string | null; name: string; summary: string;
  kind: string; tags: string[]; importance: number | null; version: number;
  updatedAt: number | null; accessCount: number; lastAccessedAt: number | null;
  deleted: boolean; deletedAt: number | null;
};
type Detail = {
  row: Row | null; details: string | null; writeReason: string | null;
  history: { version: number; at: number | null; reason: string | null }[];
};
type Stats = {
  active: number; global: number; standing: number; unused: number; forgotten: number;
  projects: { projectId: string; name: string; count: number }[];
};
type Run = {
  key: string; threadId: string | null; title: string | null;
  startedAt: number; endedAt: number; creates: number; updates: number; forgets: number;
  queueFrom: number | null; queueTo: number | null;
};
type Sweep = { active: number; touched: number; forgotten: number; frontier: number | null; runs: Run[] };
type Conflict = {
  overlap: number;
  a: { id: string; name: string; summary: string; updatedAt: number | null };
  b: { id: string; name: string; summary: string; updatedAt: number | null };
  aOnly: string[]; bOnly: string[];
};
type Family = { prefix: string; count: number; members: { id: string; name: string }[] };
type Clusters = { scanned: number; conflicts: Conflict[]; families: Family[] };
type Change = { memoryId: string; name: string; action: string; at: number; reason: string; deleted: boolean };
type View = "active" | "standing" | "unused" | "forgotten";
type Sort = "recent" | "used" | "name";
type Op = "save" | "kind" | "forget" | "restore";

const PAGE = 50;
// The memory plugin rejects anything else, so the dropdown offers exactly this.
const KINDS = ["fact", "preference", "decision", "procedure", "episode", "reference"] as const;

/** "3d ago" beats an ISO timestamp when scanning a list. */
function ago(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.round(s / 86400)}d ago`;
  return `${Math.round(s / 2592000)}mo ago`;
}
const day = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
const clock = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// Curation reasons name the record that kept the fact — "Near-duplicate of
// mem_thvu4qqt9ko" — which is the single most useful thing in a merge and was,
// as plain text, the single most annoying: the only way to see what survived was
// to copy the id into search. Linkified, a merge is one click to verify.
const MEM_ID = /\bmem_[A-Za-z0-9_-]{6,}\b/g;
function Reason({ text, onOpen }: { text: string; onOpen: (id: string) => void }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MEM_ID)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <button key={`${at}`} onClick={(e) => { e.stopPropagation(); onOpen(m[0]); }}
        className="underline decoration-dotted underline-offset-2 hover:text-foreground">
        {m[0]}
      </button>,
    );
    last = at + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
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
  const [mode, setMode] = useState<"list" | "sweep" | "clusters">("list");
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [q, setQ] = useState("");
  // What the box shows vs what we query. Typing "sandbox" used to fire seven
  // full-text queries, each spawning its own process, and the six doomed ones
  // competed for the machine with the only one whose answer would be used.
  const [qLive, setQLive] = useState("");
  const [view, setView] = useState<View>("active");
  const [sort, setSort] = useState<Sort>("recent");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [scope, setScope] = useState<"all" | "global" | "project">("all");
  const [offset, setOffset] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState<Detail | null>(null);
  // The id we are WAITING for, kept apart from the record we HAVE. Without this
  // split, clicking B while A is still in flight leaves A's body on screen under
  // no indication at all — and if A's response lands after B's, A wins and stays.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Every async read is stamped and checked on arrival. RPCs here are not
  // instant — this store is read by spawning a process per query on a machine
  // that routinely sits at load 40+ — so responses genuinely do arrive out of
  // order, and the last one to LAND was winning rather than the last one asked
  // for. That is the whole "I clicked somewhere else and still see the old
  // thing" bug, and it gets worse the faster you click, which is exactly
  // backwards from what a user expects.
  const listSeq = useRef(0);
  const detailSeq = useRef(0);

  const load = useCallback(
    async (off = offset) => {
      const seq = ++listSeq.current;
      setLoading(true);
      try {
        const r = await rpc.call("list", { scope, projectId, q: qLive, view, sort, limit: PAGE, offset: off });
        if (seq !== listSeq.current) return; // a newer query is already in flight
        setRows(r.rows as Row[]);
        setTotal(r.total);
        setErr(null);
        setCursor((c) => Math.min(c, Math.max(0, (r.rows as Row[]).length - 1)));
      } catch {
        // An empty list and a failed list look identical, and the empty one is
        // far more believable. Say which it was.
        if (seq === listSeq.current) setErr("Could not read the memory store.");
      } finally {
        if (seq === listSeq.current) setLoading(false);
      }
    },
    [scope, projectId, qLive, view, sort, offset],
  );
  // Retried, because ONE transient failure used to cost the sidebar permanently.
  // Observed 2026-08-11: the panel was opened ~2s after a plugin reload, the
  // single mount-time stats call failed, and every count and the whole project
  // list stayed blank for the life of the page — with no error anywhere, so it
  // read as "this store has no projects". bb's plugin-contributions probe is
  // known to time out under load (get-bb/bb#1313) and this machine sits at load
  // 35+, so this is the normal case, not the unlucky one.
  const refreshStats = useCallback(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        setStats((await rpc.call("stats", null)) as Stats);
        setErr(null);
        return;
      } catch {
        await new Promise((r) => window.setTimeout(r, 400 * (attempt + 1)));
      }
    }
    setErr("Could not read the memory store — counts may be stale.");
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setQLive(q), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => { void refreshStats(); }, []);
  useEffect(() => { if (mode === "list") { setOffset(0); void load(0); } }, [qLive, view, sort, scope, projectId, mode]);
  useRealtime("memory-ui.changed", () => { if (mode === "list") void load(); void refreshStats(); });

  const open = useCallback(async (id: string) => {
    const seq = ++detailSeq.current;
    setPendingId(id);
    const d = (await rpc.call("get", { id })) as Detail;
    if (seq !== detailSeq.current) return; // something else was clicked since
    setSel(d);
    setPendingId(null);
  }, []);
  const say = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 4000); };
  // Closing must also cancel what is in flight. Otherwise a record opened and
  // dismissed before its response lands pops back open on arrival.
  const close = useCallback(() => { detailSeq.current += 1; setSel(null); setPendingId(null); }, []);
  const goList = (v: View) => { setMode("list"); setView(v); };

  // Keyboard: 1,500 records is too many to mouse through. j/k move, Enter opens,
  // / focuses search, Esc closes — the bindings a list like this should have.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA";
      if (e.key === "/" && !typing) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === "Escape") { if (typing) (document.activeElement as HTMLElement).blur(); else close(); return; }
      if (typing || mode !== "list") return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
      if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
      if (e.key === "Enter" && rows[cursor]) { e.preventDefault(); void open(rows[cursor].id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, open, mode, close]);

  const act = async (op: Op, row: Row, extra?: { summary?: string; details?: string; kind?: string }) => {
    setBusy(true);
    try {
      if (op === "forget") {
        const reason = window.prompt(`Forget "${row.name}"?\n\nIt becomes a soft delete — you can restore it from the Forgotten view.\n\nReason:`);
        if (!reason) return;
        const r = await rpc.call("forget", { id: row.id, projectId: row.projectId, expectedVersion: row.version, reason });
        r.error ? say(`Failed: ${r.error}`) : (setSel(null), say("Forgotten — find it under Forgotten to restore"));
      } else if (op === "restore") {
        const r = await rpc.call("restore", { id: row.id, reason: "restored from the Forgotten view" });
        r.error ? say(`Failed: ${r.error}`) : (setSel(null), say("Restored as a new record (new id, version 1)"));
      } else {
        const r = await rpc.call("update", {
          id: row.id, projectId: row.projectId, expectedVersion: row.version,
          reason: op === "kind" ? `memory-ui: reclassify ${row.kind} → ${extra?.kind}` : "memory-ui: manual edit",
          summary: extra?.summary ?? null, details: extra?.details ?? null,
          kind: (op === "kind" ? (extra?.kind as (typeof KINDS)[number]) : null) ?? null,
          importance: null,
        });
        if (r.error) say(`Failed: ${r.error}`);
        else if (op === "save") say("Saved");
        else { say(`Now a ${extra?.kind}`); await open(row.id); }
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
          <SideItem label="All memories" count={stats?.active}
            active={mode === "list" && view === "active" && !projectId && scope === "all"}
            onClick={() => { setMode("list"); setView("active"); setProjectId(null); setScope("all"); }} />
          {/* Was "Pinned". A pin was a flag someone had to remember to tick, and
              nobody did; `kind = 'decision'` is the same protection derived from
              what the record SAYS, which is the only version of it that keeps
              working when no human is watching. */}
          <SideItem label="Standing" count={stats?.standing} active={mode === "list" && view === "standing"}
            onClick={() => goList("standing")} />
          {/* Not "Never used": standing instructions read as never-used because
              they are injected rather than recalled, and a record written
              yesterday has not had its chance yet. Both are excluded, so the
              label says so. */}
          <SideItem label="Unused 7d+" count={stats?.unused} active={mode === "list" && view === "unused"}
            onClick={() => goList("unused")} />
          <SideItem label="Forgotten" count={stats?.forgotten} active={mode === "list" && view === "forgotten"}
            onClick={() => goList("forgotten")} muted />
        </div>
        <div className="space-y-0.5">
          <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">Curation</div>
          <SideItem label="Sweep" active={mode === "sweep"} onClick={() => { setMode("sweep"); setSel(null); }} />
          <SideItem label="Conflicts" active={mode === "clusters"} onClick={() => { setMode("clusters"); setSel(null); }} />
        </div>
        <div className="space-y-0.5">
          <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">Scope</div>
          <SideItem label="Global" count={stats?.global} active={mode === "list" && scope === "global"}
            onClick={() => { setMode("list"); setScope(scope === "global" ? "all" : "global"); setProjectId(null); setView("active"); }} />
          {stats?.projects.map((p) => (
            <SideItem key={p.projectId} label={p.name} count={p.count} active={mode === "list" && projectId === p.projectId}
              onClick={() => { setMode("list"); setProjectId(projectId === p.projectId ? null : p.projectId); setScope("all"); setView("active"); }} />
          ))}
        </div>
      </div>

      {mode === "sweep" ? (
        <SweepView onOpen={open} />
      ) : mode === "clusters" ? (
        <ClustersView onOpen={open} />
      ) : (
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

          {err && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err} <button onClick={() => { void load(); void refreshStats(); }} className="underline">Retry</button>
            </div>
          )}

          {view === "forgotten" && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Soft-deleted records, newest first — including everything the nightly curation removed.
              Restore re-adds the content as a <strong>new record</strong> (new id, version 1); the original stays here as history.
            </div>
          )}
          {view === "standing" && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Instructions you gave this machine, not facts it learned. The nightly curation may tighten,
              merge or correct one — it may never drop what it requires.
            </div>
          )}

          {rows.length === 0 && (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              {q
                ? `Nothing matches “${q}”.`
                : view === "unused"
                  // An empty delete-me list reads as broken unless it says why.
                  ? "Nothing here — standing instructions and anything written in the last 7 days are excluded."
                  : view === "standing"
                    ? "No standing instructions yet. Set a record's kind to “decision” to mark one."
                    : "Nothing here."}
            </div>
          )}

          {/* Dim rather than blank. Replacing the list with a spinner throws away
              the thing you were reading and makes every query feel like a page
              load; dimming says "this is the previous answer, a new one is
              coming" without lying about either. */}
          <div className={`space-y-1 transition-opacity ${loading ? "opacity-50" : ""}`}>
            {rows.map((r, i) => (
              <button key={r.id} onClick={() => { setCursor(i); void open(r.id); }}
                className={`block w-full rounded-md border px-3 py-2 text-left hover:bg-accent ${
                  sel?.row?.id === r.id ? "border-primary" : i === cursor ? "border-border bg-accent/40" : "border-border bg-card"
                }`}>
                <div className="flex items-center gap-2">
                  <span className={`truncate text-sm ${r.deleted ? "text-muted-foreground line-through" : "text-foreground"}`}>
                    {r.name}
                  </span>
                  {/* 92% of records are 'fact', so the badge would be wallpaper.
                      Shown only when it carries information. */}
                  {r.kind !== "fact" && (
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                      r.kind === "decision" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                    }`}>{r.kind}</span>
                  )}
                  {/* With ~1,000 project records across a dozen projects, "which
                      project is this?" is the one piece of context the row cannot
                      do without — but only when the list is not already scoped. */}
                  {!projectId && r.projectId && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {projName(r.projectId)}
                    </span>
                  )}
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
            {loading && <span className="opacity-60">loading…</span>}
            <button disabled={offset + PAGE >= total} onClick={() => { const o = offset + PAGE; setOffset(o); void load(o); }}
              className="rounded border border-border px-2 py-1 disabled:opacity-40">next →</button>
            <span className="ml-auto opacity-60">j/k move · enter open · / search · esc close</span>
          </div>
        </div>
      )}

      {/* Pending wins over stale. While a record is loading we show ITS name —
          which we already have from the row that was clicked — over an empty
          body, instead of the previous record's contents. Showing the old body
          under a new selection is not "slow", it is wrong, and it is
          indistinguishable from having loaded correctly. */}
      {pendingId ? (
        <div className="w-[400px] shrink-0 overflow-y-auto border-l border-border bg-card p-4 space-y-3">
          <div className="truncate text-sm font-medium text-foreground">
            {rows.find((r) => r.id === pendingId)?.name ?? pendingId}
          </div>
          <div className="text-xs text-muted-foreground">loading…</div>
          <div className="h-24 animate-pulse rounded-md bg-muted/60" />
          <div className="h-40 animate-pulse rounded-md bg-muted/40" />
        </div>
      ) : sel?.row ? (
        <DetailPane sel={sel} busy={busy} projectLabel={projName(sel.row.projectId)}
          onClose={close} onAct={act} onOpen={open} />
      ) : null}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

// SWEEP — the activity log the store always had and never showed.
function SweepView({ onOpen }: { onOpen: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [days, setDays] = useState(14);
  const [data, setData] = useState<Sweep | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [changes, setChanges] = useState<{ rows: Change[]; total: number } | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Same stamping as the list. A realtime "memory-ui.changed" while a reload is
  // already in flight put two sweeps in the air, and the slower one overwrote
  // the fresher answer.
  const seq = useRef(0);
  const changeSeq = useRef(0);
  const reload = useCallback(async () => {
    const s = ++seq.current;
    const d = (await rpc.call("sweep", { days })) as Sweep;
    if (s === seq.current) setData(d);
  }, [days]);
  useEffect(() => { void reload(); }, [reload]);
  useRealtime("memory-ui.changed", () => { void reload(); });

  const expand = async (run: Run) => {
    if (openRun === run.key) { changeSeq.current += 1; setOpenRun(null); setChanges(null); return; }
    const s = ++changeSeq.current;
    setOpenRun(run.key);
    setChanges(null);
    const r = (await rpc.call("runChanges", {
      threadId: run.threadId, from: run.startedAt, to: run.endedAt, limit: 200,
    })) as { changes: Change[]; total: number };
    // Expanding a second run before the first responded used to drop the first
    // run's changes into the second run's open panel.
    if (s !== changeSeq.current) return;
    setChanges({ rows: r.changes, total: r.total });
  };

  const pct = data && data.active > 0 ? Math.round((data.touched / data.active) * 100) : 0;

  // Default to runs that CHANGED existing memory. Measured over 14 days of real
  // history: 60 runs, and 8 of the 10 most recent were a single agent saving one
  // new memory — which buried the curation entirely, and is the one thing this
  // view exists to show. The discriminator is shape, not size: curation rewrites
  // and deletes, ordinary work only adds. A one-record rewrite is an agent
  // correcting something it had wrong, which is worth seeing; a one-record
  // create is visible in the main list already.
  const allRuns = data?.runs ?? [];
  const runs = showAll ? allRuns : allRuns.filter((r) => r.updates + r.forgets > 0);
  const hidden = allRuns.length - runs.length;
  // Two most recent substantial runs: if the newer one did not reach further
  // into the queue than the older one, the sweep is re-reading the same records.
  const sweeps = allRuns.filter((r) => r.updates >= 10 && r.queueTo != null);
  const stalled = sweeps.length >= 2 && (sweeps[0].queueTo ?? 0) <= (sweeps[1].queueTo ?? 0);

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium text-foreground">Sweep</div>
        {hidden > 0 && !showAll && (
          <button onClick={() => setShowAll(true)} className="text-xs text-muted-foreground underline decoration-dotted">
            + {hidden} run{hidden > 1 ? "s" : ""} that only added memories
          </button>
        )}
        {showAll && (
          <button onClick={() => setShowAll(false)} className="text-xs text-muted-foreground underline decoration-dotted">
            rewrites &amp; deletions only
          </button>
        )}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="ml-auto h-8 rounded-md border border-border bg-background px-1 text-xs">
          <option value={7}>last 7 days</option>
          <option value={14}>last 14 days</option>
          <option value={30}>last 30 days</option>
          <option value={90}>last 90 days</option>
        </select>
      </div>

      {data && (
        <div className="rounded-md border border-border bg-card p-3 space-y-2">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="text-foreground">{data.touched.toLocaleString()}</span>
            {/* "rewritten", not "curated": a bulk backfill lands in this number
                the same way a nightly curation does, and the store cannot tell
                you which. Overstating it here would turn the one honest view
                into a reassuring one. */}
            <span className="text-muted-foreground">of {data.active.toLocaleString()} records have been rewritten at least once</span>
            <span className="ml-auto tabular-nums text-xs text-muted-foreground">{pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>oldest record last touched <strong className="text-foreground">{ago(data.frontier)}</strong> — that is where the next sweep starts</span>
            <span>{data.forgotten.toLocaleString()} forgotten in total</span>
          </div>
          {stalled && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
              The last sweep did not reach further into the queue than the one before it — it is
              re-reading records it has already curated, so the backlog is not shrinking.
            </div>
          )}
        </div>
      )}

      {data && runs.length === 0 && (
        <div className="px-2 py-8 text-center text-sm text-muted-foreground">
          {allRuns.length === 0
            ? "Nothing has written to memory in this window."
            : "Nothing rewrote or deleted an existing memory in this window — only new ones were added."}
        </div>
      )}

      <div className="space-y-1">
        {runs.map((run) => (
          <div key={run.key} className="rounded-md border border-border bg-card">
            <button onClick={() => void expand(run)} className="block w-full px-3 py-2 text-left hover:bg-accent/50">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-foreground">
                  {run.title ?? run.threadId ?? "unattributed"}
                </span>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{clock(run.endedAt)}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] tabular-nums">
                {run.creates > 0 && <span className="text-muted-foreground">+{run.creates} new</span>}
                {run.updates > 0 && <span className="text-muted-foreground">~{run.updates} rewritten</span>}
                {run.forgets > 0 && <span className="text-destructive">−{run.forgets} forgotten</span>}
                {run.queueFrom != null && (
                  // Only meaningful for a batch: one interactive edit "covers"
                  // a one-record window, which is noise.
                  run.updates >= 10 && (
                    <span className="text-muted-foreground opacity-70">
                      covered records last touched {day(run.queueFrom)} → {day(run.queueTo)}
                    </span>
                  )
                )}
              </div>
            </button>

            {openRun === run.key && (
              <div className="border-t border-border px-3 py-2 space-y-1">
                {!changes && <div className="text-xs text-muted-foreground">loading…</div>}
                {changes?.rows.map((c, i) => (
                  <div key={`${c.memoryId}-${c.at}-${i}`} className="text-xs">
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${
                        c.action === "forget" ? "bg-destructive/15 text-destructive"
                          : c.action === "create" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                      }`}>{c.action}</span>
                      <button onClick={() => onOpen(c.memoryId)}
                        className={`truncate text-left hover:underline ${c.deleted ? "text-muted-foreground line-through" : "text-foreground"}`}>
                        {c.name}
                      </button>
                    </div>
                    {c.reason && (
                      <div className="pl-1 text-muted-foreground"><Reason text={c.reason} onOpen={onOpen} /></div>
                    )}
                  </div>
                ))}
                {changes && changes.total > changes.rows.length && (
                  <div className="text-xs text-muted-foreground opacity-70">
                    showing {changes.rows.length} of {changes.total} changes in this run
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Said plainly rather than left to be discovered: the nightly curation
          caps how many records it may delete in one run, and the proposals that
          cap refuses never reach this database at all. They are in the workflow's
          own report. A view that silently omitted them would read as "this is
          everything that happened". */}
      <div className="pt-1 text-[11px] text-muted-foreground opacity-70">
        Deletions the nightly cap refused are not shown here — they were never written, so no record of
        them exists in the store. The curation run's own report has them.
      </div>
    </div>
  );
}

// CONFLICTS — where the store disagrees with itself.
//
// The cut at 0.55 is doing real work and is worth stating: on this store the two
// pairs above it are genuine contradictions (a package pin recorded as both
// ^1.2.2 and ^1.2.3; a claim marked RETRACTED living beside the claim it
// falsifies) and the two below it are SERIES — different deployments announced
// in the same words. Same detector, opposite meaning, so the weaker band is
// shown on request rather than mixed in.
const STRONG = 0.55;

function ValueChip({ v, tone }: { v: string; tone: "a" | "b" }) {
  return (
    <span className={`rounded px-1 py-0.5 font-mono text-[10px] ${
      tone === "a" ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive"
    }`}>{v}</span>
  );
}

function ClustersView({ onOpen }: { onOpen: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Clusters | null>(null);
  const [weak, setWeak] = useState(false);
  const [openFam, setOpenFam] = useState<string | null>(null);

  const seq = useRef(0);
  const reload = useCallback(async () => {
    const s = ++seq.current;
    const d = (await rpc.call("clusters", { limit: 40 })) as Clusters;
    if (s === seq.current) setData(d);
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useRealtime("memory-ui.changed", () => { void reload(); });

  const all = data?.conflicts ?? [];
  const strong = all.filter((c) => c.overlap >= STRONG);
  const shown = weak ? all : strong;

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium text-foreground">Conflicts</div>
          {all.length > strong.length && (
            <button onClick={() => setWeak(!weak)} className="ml-auto text-xs text-muted-foreground underline decoration-dotted">
              {weak ? "strong matches only" : `+ ${all.length - strong.length} weaker match${all.length - strong.length > 1 ? "es" : ""}`}
            </button>
          )}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Two records saying nearly the same sentence with a <strong>different number</strong> — a version, an
          id, a date. Whichever one an agent recalls first wins, so this is the store contradicting itself
          rather than merely repeating itself.
        </div>
      </div>

      {data && shown.length === 0 && (
        <div className="rounded-md border border-border bg-card px-3 py-6 text-center text-sm text-muted-foreground">
          No numeric disagreements across {data.scanned.toLocaleString()} records.
        </div>
      )}

      <div className="space-y-2">
        {shown.map((c) => (
          <div key={`${c.a.id}:${c.b.id}`} className="rounded-md border border-border bg-card p-3 space-y-2">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{Math.round(c.overlap * 100)}% of the wording is shared</span>
              {c.overlap < STRONG && (
                <span className="rounded bg-muted px-1.5 py-0.5">weaker — often a series, not a conflict</span>
              )}
              <span className="ml-auto flex items-center gap-1">
                {c.aOnly.map((v) => <ValueChip key={v} v={v} tone="a" />)}
                <span className="opacity-50">vs</span>
                {c.bOnly.map((v) => <ValueChip key={v} v={v} tone="b" />)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[c.a, c.b].map((side, i) => (
                <button key={side.id} onClick={() => onOpen(side.id)}
                  className={`rounded-md border p-2 text-left hover:bg-accent ${
                    i === 0 ? "border-primary/40" : "border-destructive/40"
                  }`}>
                  <div className="truncate text-xs text-foreground">{side.name}</div>
                  <div className="mt-0.5 line-clamp-4 text-[11px] text-muted-foreground">{side.summary}</div>
                  <div className="mt-1 text-[10px] text-muted-foreground opacity-70">updated {ago(side.updatedAt)}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div>
        <div className="text-sm font-medium text-foreground">Families</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Records are named as slugs and arrive in series, so a shared name prefix is the store's real
          topology — everything it knows about one subject. This is a fact about the names, not a claim
          that any two of these say the same thing.
        </div>
      </div>

      <div className="space-y-1">
        {data?.families.map((f) => (
          <div key={f.prefix} className="rounded-md border border-border bg-card">
            <button onClick={() => setOpenFam(openFam === f.prefix ? null : f.prefix)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50">
              <span className="truncate font-mono text-xs text-foreground">{f.prefix}</span>
              <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">{f.count}</span>
            </button>
            {openFam === f.prefix && (
              <div className="border-t border-border px-3 py-2 space-y-0.5">
                {f.members.map((m) => (
                  <button key={m.id} onClick={() => onOpen(m.id)}
                    className="block w-full truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline">
                    {m.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* The limit, said out loud. This detector compares NUMBERS; two records
          that contradict each other in words alone ("DEAD" versus
          "operator-approved") share no differing value and will not appear.
          Leaving that unsaid would make an empty list read as "no contradictions". */}
      <div className="pt-1 text-[11px] text-muted-foreground opacity-70">
        Only numeric disagreements are detectable here. Two records that contradict each other in words
        alone will not show up — that judgement is the nightly curation's job.
      </div>
    </div>
  );
}

function DetailPane({ sel, busy, projectLabel, onClose, onAct, onOpen }: {
  sel: Detail; busy: boolean; projectLabel: string; onClose: () => void;
  onAct: (op: Op, row: Row, extra?: { summary?: string; details?: string; kind?: string }) => Promise<void>;
  onOpen: (id: string) => void;
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
            {sel.writeReason ? <>Forgotten because: <em><Reason text={sel.writeReason} onOpen={onOpen} /></em></> : "Forgotten."}
          </div>
          <div className="whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-xs">{sel.details ?? row.summary}</div>
          <button disabled={busy} onClick={() => void onAct("restore", row)}
            className="w-full rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40">
            Restore this memory
          </button>
        </>
      ) : (
        <>
          {/* This replaced the Pin button. Not the same gesture renamed: a pin
              was UI state that meant nothing to anything else, while `kind` is
              part of the record — it is what the curation rules read, so setting
              it to "decision" is what actually protects the record from being
              curated away. */}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            kind
            <select value={row.kind} disabled={busy}
              onChange={(e) => void onAct("kind", row, { kind: e.target.value })}
              className="h-7 rounded-md border border-border bg-background px-1 text-xs">
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            {row.kind === "decision" && (
              <span className="text-[11px] text-primary">the nightly sweep may not drop this</span>
            )}
          </label>
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
            <button disabled={busy} onClick={() => void onAct("forget", row)}
              className="ml-auto rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive">Forget…</button>
          </div>
        </>
      )}

      {sel.history.length > 0 && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="font-medium">history</div>
          {sel.history.map((h) => (
            <div key={h.version} className="truncate">
              v{h.version} · {ago(h.at)} · {h.reason ? <Reason text={h.reason} onOpen={onOpen} /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Homepage: the standing instructions, which is what the pinned section was
// reaching for. Pinning required someone to maintain a flag; this is derived
// from the records themselves, so it is right by default and cannot go stale.
function StandingSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    void rpc.call("list", { scope: "all", projectId: null, q: "", view: "standing", sort: "recent", limit: 6, offset: 0 })
      .then((r) => setRows(r.rows as Row[]));
  }, []);
  if (!rows.length) return null;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.id} className="rounded-md border border-border bg-card px-3 py-2">
          <div className="text-sm text-foreground">{r.name}</div>
          <div className="line-clamp-2 text-xs text-muted-foreground">{r.summary}</div>
        </div>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "memory", title: "Memory", icon: "Brain", path: "memory", component: MemoryPanel });
  app.slots.homepageSection({ id: "standing-memories", title: "Standing instructions", component: StandingSection });
});
