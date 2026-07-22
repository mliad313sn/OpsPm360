"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, FileDown, Gavel, ShieldAlert, X } from "lucide-react";
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
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

type Rag = "RED" | "AMBER" | "GREEN";
const RAG_ORDER: Record<Rag, number> = { RED: 0, AMBER: 1, GREEN: 2 };

interface WarRoomProps {
  rows: PortfolioRow[];
  canSteer: boolean;
}

type DrawerTab = "decision" | "blocker" | "override";

export function WarRoom({ rows, canSteer }: WarRoomProps): JSX.Element {
  const [atRiskOnly, setAtRiskOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<string | null>(null);
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

  const selected = sorted.find((r) => r.id === selectedId) ?? null;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, successMsg: string) {
    startTransition(async () => {
      const result = await fn();
      setFeedback(result.ok ? successMsg : (result.error ?? "Action failed"));
    });
  }

  function handleStartMeeting() {
    startTransition(async () => {
      const result = await startMeetingAction();
      if (result.ok) {
        setMeetingId(result.data.meetingId);
        setFeedback("Meeting session open — decisions are being recorded.");
      } else {
        setFeedback(result.error);
      }
    });
  }

  function handleCloseMeeting() {
    if (!meetingId) return;
    startTransition(async () => {
      const result = await closeMeetingAction(meetingId);
      if (result.ok) {
        setMinutes(result.data.minutesMarkdown);
        setMeetingId(null);
        setFeedback("Meeting closed — minutes generated below.");
      } else {
        setFeedback(result.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Steering Committee War Room</h1>
        <Button
          size="sm"
          variant={atRiskOnly ? "default" : "outline"}
          onClick={() => setAtRiskOnly((v) => !v)}
        >
          <AlertTriangle className="h-4 w-4" aria-hidden />
          {atRiskOnly ? "Showing Red/Amber only" : "Showing all"}
        </Button>
        {canSteer ? (
          meetingId ? (
            <Button size="sm" variant="destructive" onClick={handleCloseMeeting} disabled={pending}>
              <FileDown className="h-4 w-4" aria-hidden />
              Close meeting &amp; generate minutes
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={handleStartMeeting} disabled={pending}>
              <Gavel className="h-4 w-4" aria-hidden />
              Start meeting session
            </Button>
          )
        ) : null}
        {feedback ? (
          <span role="status" className="text-xs text-muted-foreground">
            {feedback}
          </span>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-2">
          {sorted.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setSelectedId(r.id)}
              className={cn(
                "glass w-full rounded-lg p-3 text-left transition-colors hover:border-primary/50",
                selectedId === r.id && "border-primary"
              )}
            >
              <div className="flex items-center gap-3">
                <RagBadge rag={r.rag} overridden={r.ragOverride !== null} />
                <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
                <span className="font-medium">{r.title}</span>
                <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{r.siteName ?? "Group"}</span>
                  <span className="tabular">
                    {formatMoneyCompact(r.totalActualUSD)} / {formatMoneyCompact(r.totalBudgetUSD)}
                  </span>
                  {r.variancePct !== null && r.variancePct > 15 ? (
                    <Badge variant="red">+{r.variancePct.toFixed(0)}% over</Badge>
                  ) : null}
                  {r.criticalBlockerCount > 0 ? (
                    <Badge variant="red">
                      <ShieldAlert className="mr-1 h-3 w-3" aria-hidden />
                      {r.criticalBlockerCount} critical
                    </Badge>
                  ) : r.openBlockerCount > 0 ? (
                    <Badge variant="amber">{r.openBlockerCount} blockers</Badge>
                  ) : null}
                  <span>due {formatDate(r.targetEndDate)}</span>
                </span>
              </div>
            </button>
          ))}
          {sorted.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                Nothing at risk — the portfolio is green. 🎉
              </CardContent>
            </Card>
          ) : null}
        </div>

        {selected ? (
          <PresenterDrawer
            key={selected.id}
            project={selected}
            meetingId={meetingId}
            canSteer={canSteer}
            pending={pending}
            onClose={() => setSelectedId(null)}
            run={run}
          />
        ) : (
          <Card className="h-fit">
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              Select a project to open presenter controls.
            </CardContent>
          </Card>
        )}
      </div>

      {minutes ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Meeting minutes (Markdown)</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(minutes);
                setFeedback("Minutes copied to clipboard.");
              }}
            >
              Copy
            </Button>
          </CardHeader>
          <CardContent>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
              {minutes}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function PresenterDrawer({
  project,
  meetingId,
  canSteer,
  pending,
  onClose,
  run,
}: {
  project: PortfolioRow;
  meetingId: string | null;
  canSteer: boolean;
  pending: boolean;
  onClose: () => void;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, successMsg: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<DrawerTab>("decision");

  const [decisionType, setDecisionType] = useState("UNBLOCK");
  const [actionTaken, setActionTaken] = useState("");

  const [blockerTitle, setBlockerTitle] = useState("");
  const [blockerDesc, setBlockerDesc] = useState("");
  const [blockerSeverity, setBlockerSeverity] = useState("HIGH");

  const [overrideRag, setOverrideRag] = useState<Rag | "CLEAR">("AMBER");
  const [overrideReason, setOverrideReason] = useState("");

  return (
    <Card className="h-fit">
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle>{project.title}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {project.code} · {project.siteName ?? "Group"} · Gate{" "}
            {project.currentGate.replaceAll("_", " ")}
          </p>
          {project.ragOverride ? (
            <p className="mt-1 text-xs text-rag-amber">
              RAG manually overridden: {project.ragOverrideReason}
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close drawer">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!canSteer ? (
          <p className="text-xs text-muted-foreground">
            Read-only view — steering actions require a Group IT Manager.
          </p>
        ) : (
          <>
            <div className="flex gap-1">
              {(
                [
                  ["decision", "Log decision"],
                  ["blocker", "Log blocker"],
                  ["override", "Override RAG"],
                ] as [DrawerTab, string][]
              ).map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={tab === key ? "default" : "outline"}
                  onClick={() => setTab(key)}
                >
                  {label}
                </Button>
              ))}
            </div>

            {tab === "decision" ? (
              <div className="space-y-2">
                {!meetingId ? (
                  <p className="text-xs text-rag-amber">
                    Start a meeting session to record decisions in the ledger.
                  </p>
                ) : null}
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
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
                  disabled={pending || !meetingId || actionTaken.trim().length < 3}
                  onClick={() =>
                    run(
                      () =>
                        recordDecisionAction({
                          meetingId: meetingId ?? "",
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
              <div className="space-y-2">
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
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
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
                  disabled={pending || blockerTitle.trim().length < 3 || blockerDesc.trim().length < 1}
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
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Calculated: <RagBadge rag={project.ragCalculated} />. Overrides require a reason
                  and are written to the audit trail.
                </p>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
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
                  placeholder="Justification (min 10 characters, audited)…"
                />
                <Button
                  className="w-full"
                  disabled={pending || overrideReason.trim().length < 10}
                  onClick={() =>
                    run(
                      () =>
                        overrideRagAction({
                          projectId: project.id,
                          override: overrideRag === "CLEAR" ? null : overrideRag,
                          reason: overrideReason.trim(),
                        }),
                      overrideRag === "CLEAR" ? "Override cleared." : `RAG overridden to ${overrideRag}.`
                    )
                  }
                >
                  Apply override
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
