"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  ArrowUpDown,
  Ban,
  FileDown,
  FilePenLine,
  Gavel,
  ShieldAlert,
  Timer,
} from "lucide-react";
import type { PortfolioRow } from "@/server/queries";
import { overrideRagAction } from "@/server/actions/projects";
import { createBlockerAction } from "@/server/actions/blockers";
import {
  closeMeetingAction,
  recordDecisionAction,
  startMeetingAction,
} from "@/server/actions/meetings";
import { Button } from "@/components/ui/button";
import { Badge, RagBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { formatMoneyCompact } from "@/lib/finance";
import { cn, formatDate } from "@/lib/utils";

type Rag = "RED" | "AMBER" | "GREEN";
const RAG_ORDER: Record<Rag, number> = { RED: 0, AMBER: 1, GREEN: 2 };

export interface MeetingSession {
  id: string;
  chairName: string;
  startedAt: string; // ISO
  decisions: {
    id: string;
    decisionType: string;
    actionTaken: string;
    projectCode: string;
    by: string;
    at: string; // ISO
  }[];
}

type ActionTab = "decision" | "blocker" | "override";

function ElapsedTimer({ since }: { since: string }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const h = String(Math.floor(secs / 3600)).padStart(2, "0");
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  return (
    <span className="meta flex items-center gap-1.5 text-sm text-muted-foreground">
      <Timer className="h-4 w-4" aria-hidden />
      {h}:{m}:{s} elapsed
    </span>
  );
}

export function WarRoom({
  rows,
  canSteer,
  session,
}: {
  rows: PortfolioRow[];
  canSteer: boolean;
  session: MeetingSession | null;
}): JSX.Element {
  const [atRiskOnly, setAtRiskOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<string | null>(null);
  const [closedMeetingId, setClosedMeetingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const sorted = useMemo(
    () =>
      [...rows]
        .filter((r) => r.status !== "COMPLETED")
        .filter((r) => (atRiskOnly ? r.rag !== "GREEN" : true))
        .sort((a, b) => RAG_ORDER[a.rag] - RAG_ORDER[b.rag] || a.code.localeCompare(b.code)),
    [rows, atRiskOnly]
  );

  const selected = sorted.find((r) => r.id === selectedId) ?? sorted[0] ?? null;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, successMsg: string) {
    startTransition(async () => {
      const result = await fn();
      setFeedback(result.ok ? successMsg : (result.error ?? "Action failed"));
    });
  }

  function handleStartMeeting() {
    startTransition(async () => {
      const result = await startMeetingAction();
      setFeedback(
        result.ok ? "Meeting session open — decisions are being recorded." : result.error
      );
    });
  }

  function handleCloseMeeting() {
    if (!session) return;
    startTransition(async () => {
      const result = await closeMeetingAction(session.id);
      if (result.ok) {
        setMinutes(result.data.minutesMarkdown);
        setClosedMeetingId(result.data.meetingId);
        setFeedback("Meeting closed — minutes generated below.");
      } else {
        setFeedback(result.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(340px,420px)_1fr]">
        {/* Left: Critical Path Review */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 font-display text-base">
                <AlertTriangle className="h-4 w-4 text-rag-red" aria-hidden />
                Critical Path Review
              </CardTitle>
              <Button
                size="sm"
                variant={atRiskOnly ? "default" : "secondary"}
                onClick={() => setAtRiskOnly((v) => !v)}
              >
                {atRiskOnly ? "Red/Amber" : "All"}
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="stat-label">
                Filtered by RAG status: {atRiskOnly ? "Red, Amber" : "All"}
              </p>
              {sorted.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={cn(
                    "w-full rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/60",
                    selected?.id === r.id ? "border-2 border-primary" : "border-border"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="meta text-xs text-muted-foreground">{r.code}</span>
                    <RagBadge rag={r.rag} overridden={r.ragOverride !== null} />
                  </div>
                  <p className="mt-1 font-display text-sm font-semibold">{r.title}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="stat-label">Site</p>
                      <p>{r.siteName ?? "Group"}</p>
                    </div>
                    <div>
                      <p className="stat-label">Spend</p>
                      <p className="tabular">
                        {formatMoneyCompact(r.totalActualUSD)} /{" "}
                        {formatMoneyCompact(r.totalBudgetUSD)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2 border-t pt-2 text-xs text-muted-foreground">
                    {r.criticalBlockerCount > 0 ? (
                      <Badge variant="red" dot>
                        <ShieldAlert className="h-3 w-3" aria-hidden />
                        {r.criticalBlockerCount} critical
                      </Badge>
                    ) : r.openBlockerCount > 0 ? (
                      <Badge variant="amber" dot>
                        {r.openBlockerCount} blockers
                      </Badge>
                    ) : (
                      <span>No blockers</span>
                    )}
                    <span className="ml-auto">due {formatDate(r.targetEndDate)}</span>
                  </div>
                </button>
              ))}
              {sorted.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nothing at risk — the portfolio is green. 🎉
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {/* Right: Steering Committee Sync */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-4">
                <CardTitle className="font-display text-xl font-bold">
                  Steering Committee Sync
                </CardTitle>
                {session ? <ElapsedTimer since={session.startedAt} /> : null}
              </div>
              {canSteer ? (
                session ? (
                  <Button variant="default" onClick={handleCloseMeeting} disabled={pending}>
                    Close Session
                  </Button>
                ) : (
                  <Button variant="default" onClick={handleStartMeeting} disabled={pending}>
                    <Gavel className="h-4 w-4" aria-hidden /> Start Session
                  </Button>
                )
              ) : null}
            </CardHeader>
            {session ? (
              <CardContent className="pt-0">
                <p className="text-xs text-muted-foreground">
                  Chaired by {session.chairName} · {session.decisions.length} decisions logged
                </p>
              </CardContent>
            ) : null}
          </Card>

          {selected ? (
            <ActiveDiscussion
              key={selected.id}
              project={selected}
              session={session}
              canSteer={canSteer}
              pending={pending}
              run={run}
            />
          ) : (
            <Card>
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                Select a project on the left to open presenter controls.
              </CardContent>
            </Card>
          )}

          {feedback ? (
            <p role="status" className="text-xs text-muted-foreground">
              {feedback}
            </p>
          ) : null}
        </div>
      </div>

      {minutes ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="font-display text-base">Meeting minutes</CardTitle>
            <div className="flex gap-2">
              {closedMeetingId ? (
                <a
                  href={`/meeting/minutes/${closedMeetingId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="meta inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium hover:bg-secondary"
                >
                  <FileDown className="h-3.5 w-3.5" aria-hidden />
                  Generate Minutes (MD/PDF)
                </a>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(minutes);
                  setFeedback("Minutes copied to clipboard.");
                }}
              >
                Copy Markdown
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <pre className="meta max-h-72 overflow-auto whitespace-pre-wrap rounded bg-secondary p-3 text-xs">
              {minutes}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function ActiveDiscussion({
  project,
  session,
  canSteer,
  pending,
  run,
}: {
  project: PortfolioRow;
  session: MeetingSession | null;
  canSteer: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, successMsg: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<ActionTab | null>(null);

  const [decisionType, setDecisionType] = useState("UNBLOCK");
  const [actionTaken, setActionTaken] = useState("");

  const [blockerTitle, setBlockerTitle] = useState("");
  const [blockerDesc, setBlockerDesc] = useState("");
  const [blockerSeverity, setBlockerSeverity] = useState("HIGH");

  const [overrideRag, setOverrideRag] = useState<Rag | "CLEAR">("AMBER");
  const [overrideReason, setOverrideReason] = useState("");

  const [quickNote, setQuickNote] = useState("");

  const tiles: { key: ActionTab; label: string; icon: typeof FilePenLine }[] = [
    { key: "decision", label: "Record Decision", icon: FilePenLine },
    { key: "blocker", label: "Log Blocker", icon: Ban },
    { key: "override", label: "Override RAG", icon: ArrowUpDown },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        {/* Active discussion header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="stat-label">Active discussion</p>
            <h2 className="mt-1 font-display text-2xl font-bold leading-tight">
              {project.title}
            </h2>
            <p className="meta mt-1 text-xs text-muted-foreground">
              {project.code} · {project.siteName ?? "Group"} · Gate{" "}
              {project.currentGate.replaceAll("_", " ")}
            </p>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">{project.description}</p>
            {project.ragOverride ? (
              <p className="mt-1 text-xs text-rag-amber">
                Override active: {project.ragOverrideReason}
              </p>
            ) : null}
          </div>
          <div className="shrink-0 rounded-lg border border-rag-amber/40 bg-rag-amber/10 px-3 py-2 text-center">
            <p className="stat-label">Status</p>
            <RagBadge rag={project.rag} overridden={project.ragOverride !== null} />
          </div>
        </div>

        {canSteer ? (
          <>
            {/* Action tiles */}
            <div className="grid grid-cols-3 gap-3">
              {tiles.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(tab === t.key ? null : t.key)}
                  className={cn(
                    "meta flex flex-col items-center gap-2 rounded-lg border bg-card px-3 py-4 text-xs font-medium transition-colors hover:border-primary/60",
                    tab === t.key ? "border-2 border-primary text-primary" : "border-border"
                  )}
                >
                  <t.icon className="h-5 w-5" aria-hidden />
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "decision" ? (
              <div className="space-y-2 rounded-lg border p-3">
                {!session ? (
                  <p className="text-xs text-rag-amber">
                    Start a session to record decisions in the ledger.
                  </p>
                ) : null}
                <select
                  className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                  value={decisionType}
                  onChange={(e) => setDecisionType(e.target.value)}
                  aria-label="Decision type"
                >
                  {["UNBLOCK", "SCOPE_APPROVED", "SCOPE_REJECTED", "PAUSE", "RESUME", "ESCALATE_TO_CIO"].map(
                    (d) => (
                      <option key={d} value={d}>
                        {d.replaceAll("_", " ")}
                      </option>
                    )
                  )}
                </select>
                <Textarea
                  value={actionTaken}
                  onChange={(e) => setActionTaken(e.target.value)}
                  placeholder="Action agreed by the committee…"
                />
                <Button
                  className="w-full"
                  disabled={pending || !session || actionTaken.trim().length < 3}
                  onClick={() =>
                    run(
                      () =>
                        recordDecisionAction({
                          meetingId: session?.id ?? "",
                          projectId: project.id,
                          decisionType,
                          actionTaken: actionTaken.trim(),
                        }),
                      "Decision recorded in the ledger."
                    )
                  }
                >
                  Record decision
                </Button>
              </div>
            ) : null}

            {tab === "blocker" ? (
              <div className="space-y-2 rounded-lg border p-3">
                <Input
                  value={blockerTitle}
                  onChange={(e) => setBlockerTitle(e.target.value)}
                  placeholder="Blocker title"
                />
                <Textarea
                  value={blockerDesc}
                  onChange={(e) => setBlockerDesc(e.target.value)}
                  placeholder="What is blocked and why…"
                />
                <select
                  className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                  value={blockerSeverity}
                  onChange={(e) => setBlockerSeverity(e.target.value)}
                  aria-label="Blocker severity"
                >
                  {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <Button
                  className="w-full"
                  disabled={
                    pending || blockerTitle.trim().length < 3 || blockerDesc.trim().length < 1
                  }
                  onClick={() =>
                    run(
                      () =>
                        createBlockerAction({
                          projectId: project.id,
                          title: blockerTitle.trim(),
                          description: blockerDesc.trim(),
                          severity: blockerSeverity,
                        }),
                      "Blocker logged — SLA clock started."
                    )
                  }
                >
                  Log blocker
                </Button>
              </div>
            ) : null}

            {tab === "override" ? (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">
                  Calculated status: <RagBadge rag={project.ragCalculated} />. Overrides require
                  justification and are written to the audit trail.
                </p>
                <select
                  className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                  value={overrideRag}
                  onChange={(e) => setOverrideRag(e.target.value as Rag | "CLEAR")}
                  aria-label="Override RAG value"
                >
                  <option value="RED">RED</option>
                  <option value="AMBER">AMBER</option>
                  <option value="GREEN">GREEN</option>
                  <option value="CLEAR">Clear override (use calculated)</option>
                </select>
                <Textarea
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Enter mandatory business justification for status override…"
                />
                <Button
                  className="w-full"
                  variant="destructive"
                  disabled={pending || overrideReason.trim().length < 10}
                  onClick={() =>
                    run(
                      () =>
                        overrideRagAction({
                          projectId: project.id,
                          override: overrideRag === "CLEAR" ? null : overrideRag,
                          reason: overrideReason.trim(),
                        }),
                      overrideRag === "CLEAR"
                        ? "Override cleared."
                        : `RAG overridden to ${overrideRag}.`
                    )
                  }
                >
                  Submit Override
                </Button>
              </div>
            ) : null}

            {/* Decision ledger */}
            <div className="rounded-lg border">
              <div className="th-band flex items-center justify-between rounded-t-lg px-3 py-2">
                <span>Decision ledger</span>
                <span>{session ? "Auto-syncing" : "No open session"}</span>
              </div>
              <div className="max-h-56 space-y-2 overflow-auto p-3">
                {(session?.decisions ?? []).map((d) => (
                  <div key={d.id} className="flex gap-3 rounded-md border p-2.5">
                    <span
                      className={cn(
                        "meta mt-0.5 h-fit shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                        d.decisionType === "NOTE"
                          ? "bg-secondary text-muted-foreground"
                          : "bg-primary/10 text-primary"
                      )}
                    >
                      {d.decisionType.replaceAll("_", " ")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{d.actionTaken}</p>
                      <p className="meta mt-0.5 text-[10px] text-muted-foreground">
                        {d.projectCode} · {d.by} ·{" "}
                        {new Date(d.at).toISOString().slice(11, 16)} UTC
                      </p>
                    </div>
                  </div>
                ))}
                {!session || session.decisions.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted-foreground">
                    No decisions logged yet.
                  </p>
                ) : null}
              </div>
              {/* Quick log note */}
              <div className="flex gap-2 border-t p-3">
                <Input
                  value={quickNote}
                  onChange={(e) => setQuickNote(e.target.value)}
                  placeholder="Quick log note…"
                  disabled={!session}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && session && quickNote.trim().length >= 3) {
                      run(
                        () =>
                          recordDecisionAction({
                            meetingId: session.id,
                            projectId: project.id,
                            decisionType: "NOTE",
                            actionTaken: quickNote.trim(),
                          }),
                        "Note logged."
                      );
                      setQuickNote("");
                    }
                  }}
                />
                <Button
                  disabled={pending || !session || quickNote.trim().length < 3}
                  onClick={() => {
                    if (!session) return;
                    run(
                      () =>
                        recordDecisionAction({
                          meetingId: session.id,
                          projectId: project.id,
                          decisionType: "NOTE",
                          actionTaken: quickNote.trim(),
                        }),
                      "Note logged."
                    );
                    setQuickNote("");
                  }}
                >
                  Log
                </Button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Read-only view — steering actions require a Group IT Manager.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
