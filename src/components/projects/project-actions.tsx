"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { advanceGateAction } from "@/server/actions/projects";
import { resolveBlockerAction } from "@/server/actions/blockers";
import { GATE_EXIT_CHECKLISTS, isGate, nextGate, type Gate } from "@/lib/gates";
import {
  createScopeChangeAction,
  decideScopeChangeAction,
} from "@/server/actions/scope-changes";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { formatMoneyCompact } from "@/lib/finance";
import { formatDate } from "@/lib/utils";

function GateAdvanceCard({
  projectId,
  currentGate,
  pending,
  startTransition,
  afterAction,
}: {
  projectId: string;
  currentGate: string;
  pending: boolean;
  startTransition: React.TransitionStartFunction;
  afterAction: (result: { ok: boolean; error?: string }, msg: string) => void;
}): JSX.Element {
  const gate: Gate | null = isGate(currentGate) ? currentGate : null;
  const target = gate ? nextGate(gate) : null;
  const items = gate ? GATE_EXIT_CHECKLISTS[gate] : [];
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const allConfirmed = items.every((i) => answers[i.key] === true);

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Stage gate (COBIT 2019)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!gate || !target ? (
          <p className="text-sm text-muted-foreground">
            Project is at its final gate — no further advancement.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Confirm every exit item of{" "}
              <span className="font-medium">{gate.replaceAll("_", " ")}</span> to advance to{" "}
              <span className="font-medium">{target.replaceAll("_", " ")}</span>. The checklist
              snapshot is audited.
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              {items.map((item) => (
                <label key={item.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={answers[item.key] === true}
                    onChange={(e) => setAnswers({ ...answers, [item.key]: e.target.checked })}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                  />
                  {item.label}
                </label>
              ))}
            </div>
            <Button
              size="sm"
              disabled={pending || !allConfirmed}
              onClick={() =>
                startTransition(async () => {
                  const result = await advanceGateAction({ projectId, checklist: answers });
                  afterAction(result, `Gate advanced to ${target.replaceAll("_", " ")}.`);
                  setAnswers({});
                })
              }
            >
              Advance to {target.replaceAll("_", " ")}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface BlockerRow {
  id: string;
  title: string;
  severity: string;
  status: string;
  escalationLevel: string;
  createdAt: string;
  raisedByName: string;
}

interface ScopeChangeRow {
  id: string;
  description: string;
  budgetImpactUSD: number;
  timeImpactDays: number;
  status: string;
  requestedByName: string;
}

export function ProjectActions({
  projectId,
  currentGate,
  blockers,
  scopeChanges,
  canSteer,
  canWrite,
}: {
  projectId: string;
  currentGate: string;
  blockers: BlockerRow[];
  scopeChanges: ScopeChangeRow[];
  canSteer: boolean;
  canWrite: boolean;
}): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<string | null>(null);

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState("");

  const [scDescription, setScDescription] = useState("");
  const [scBudget, setScBudget] = useState("0");
  const [scDays, setScDays] = useState("0");

  function afterAction(result: { ok: boolean; error?: string }, msg: string) {
    if (result.ok) {
      setFeedback(msg);
      router.refresh();
    } else {
      setFeedback(result.error ?? "Action failed");
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {canWrite ? (
        <GateAdvanceCard
          projectId={projectId}
          currentGate={currentGate}
          pending={pending}
          startTransition={startTransition}
          afterAction={afterAction}
        />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Blockers &amp; escalation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {blockers.map((b) => (
            <div key={b.id} className="rounded border border-border/50 p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    b.severity === "CRITICAL" ? "red" : b.severity === "HIGH" ? "amber" : "default"
                  }
                >
                  {b.severity}
                </Badge>
                <span className="font-medium">{b.title}</span>
                <Badge variant={b.status === "RESOLVED" ? "green" : "outline"}>{b.status}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {b.escalationLevel.replaceAll("_", " ")} · raised {formatDate(b.createdAt)} by{" "}
                  {b.raisedByName}
                </span>
              </div>
              {canWrite && b.status !== "RESOLVED" ? (
                resolvingId === b.id ? (
                  <div className="mt-2 space-y-2">
                    <Textarea
                      value={resolutionNotes}
                      onChange={(e) => setResolutionNotes(e.target.value)}
                      placeholder="Resolution notes (min 5 characters)…"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={pending || resolutionNotes.trim().length < 5}
                        onClick={() =>
                          startTransition(async () => {
                            const result = await resolveBlockerAction({
                              blockerId: b.id,
                              resolutionNotes: resolutionNotes.trim(),
                            });
                            afterAction(result, "Blocker resolved.");
                            setResolvingId(null);
                            setResolutionNotes("");
                          })
                        }
                      >
                        Confirm resolve
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setResolvingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => setResolvingId(b.id)}
                  >
                    Resolve…
                  </Button>
                )
              ) : null}
            </div>
          ))}
          {blockers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No blockers raised.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scope changes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {scopeChanges.map((s) => (
            <div key={s.id} className="rounded border border-border/50 p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    s.status === "APPROVED" ? "green" : s.status === "REJECTED" ? "red" : "amber"
                  }
                >
                  {s.status}
                </Badge>
                <span className="tabular text-xs">
                  {s.budgetImpactUSD >= 0 ? "+" : ""}
                  {formatMoneyCompact(s.budgetImpactUSD)} · {s.timeImpactDays >= 0 ? "+" : ""}
                  {s.timeImpactDays}d
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  by {s.requestedByName}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
              {canSteer && s.status === "PENDING" ? (
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await decideScopeChangeAction({
                          requestId: s.id,
                          approve: true,
                        });
                        afterAction(result, "Scope change approved — baseline updated.");
                      })
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await decideScopeChangeAction({
                          requestId: s.id,
                          approve: false,
                        });
                        afterAction(result, "Scope change rejected.");
                      })
                    }
                  >
                    Reject
                  </Button>
                </div>
              ) : null}
            </div>
          ))}

          {canWrite ? (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">Request scope change</p>
              <Textarea
                value={scDescription}
                onChange={(e) => setScDescription(e.target.value)}
                placeholder="Describe the scope delta (min 10 characters)…"
              />
              <div className="flex gap-2">
                <label className="flex-1 text-xs text-muted-foreground">
                  Budget impact (USD)
                  <Input
                    type="number"
                    step="1000"
                    value={scBudget}
                    onChange={(e) => setScBudget(e.target.value)}
                  />
                </label>
                <label className="flex-1 text-xs text-muted-foreground">
                  Schedule impact (days)
                  <Input
                    type="number"
                    step="1"
                    value={scDays}
                    onChange={(e) => setScDays(e.target.value)}
                  />
                </label>
              </div>
              <Button
                size="sm"
                disabled={pending || scDescription.trim().length < 10}
                onClick={() =>
                  startTransition(async () => {
                    const result = await createScopeChangeAction({
                      projectId,
                      scopeDeltaDescription: scDescription.trim(),
                      budgetImpactUSD: Number(scBudget) || 0,
                      timeImpactDays: Math.trunc(Number(scDays)) || 0,
                    });
                    afterAction(result, "Scope change submitted for approval.");
                    setScDescription("");
                    setScBudget("0");
                    setScDays("0");
                  })
                }
              >
                Submit request
              </Button>
            </div>
          ) : null}

          {feedback ? (
            <p role="status" className="text-xs text-muted-foreground">
              {feedback}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
