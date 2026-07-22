"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { advanceGateAction } from "@/server/actions/projects";
import { resolveBlockerAction } from "@/server/actions/blockers";
import {
  createRiskAction,
  realizeRiskAsBlockerAction,
  updateRiskStatusAction,
} from "@/server/actions/risks";
import { GATE_EXIT_CHECKLISTS, isGate, nextGate, type Gate } from "@/lib/gates";
import { riskBand, riskScore } from "@/lib/risk";
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

interface RiskRow {
  id: string;
  title: string;
  description: string;
  category: string;
  probability: number;
  impact: number;
  potentialLossUSD: number;
  mitigation: string | null;
  status: string;
  raisedByName: string;
}

const RISK_CATEGORIES = [
  "TECHNICAL",
  "FINANCIAL",
  "SAFETY",
  "SUPPLY_CHAIN",
  "ENVIRONMENTAL",
  "REGULATORY",
] as const;

export function ProjectActions({
  projectId,
  currentGate,
  totalBudgetUSD,
  totalActualUSD,
  risks,
  blockers,
  scopeChanges,
  canSteer,
  canWrite,
}: {
  projectId: string;
  currentGate: string;
  totalBudgetUSD: number;
  totalActualUSD: number;
  risks: RiskRow[];
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
            <div key={b.id} id={`blocker-${b.id}`} className="rounded border border-border/50 p-2 text-sm scroll-mt-20 target:border-primary">
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
              {(() => {
                // What-if simulation: projected post-approval variance vs the
                // RAG thresholds (>10% caps AMBER, >20% forces RED).
                const delta = Number(scBudget) || 0;
                const newBudget = totalBudgetUSD + delta;
                if (delta === 0 || newBudget <= 0) return null;
                const projectedPct = ((totalActualUSD - newBudget) / newBudget) * 100;
                const tone =
                  projectedPct > 20
                    ? "text-rag-red"
                    : projectedPct > 10
                      ? "text-rag-amber"
                      : "text-rag-green";
                return (
                  <p className={`tabular text-xs ${tone}`} aria-live="polite">
                    What-if after approval: budget {formatMoneyCompact(newBudget)}, spend variance{" "}
                    {projectedPct >= 0 ? "+" : ""}
                    {projectedPct.toFixed(1)}%
                    {projectedPct > 20
                      ? " → would force RED"
                      : projectedPct > 10
                        ? " → would cap at AMBER"
                        : " → within thresholds"}
                    {(Number(scDays) || 0) !== 0
                      ? ` · target end shifts ${Number(scDays) > 0 ? "+" : ""}${Math.trunc(Number(scDays))}d`
                      : ""}
                  </p>
                );
              })()}
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
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {feedback}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <RiskPanel
        projectId={projectId}
        risks={risks}
        canWrite={canWrite}
        pending={pending}
        startTransition={startTransition}
        afterAction={afterAction}
      />
    </div>
  );
}

function RiskPanel({
  projectId,
  risks,
  canWrite,
  pending,
  startTransition,
  afterAction,
}: {
  projectId: string;
  risks: RiskRow[];
  canWrite: boolean;
  pending: boolean;
  startTransition: React.TransitionStartFunction;
  afterAction: (result: { ok: boolean; error?: string }, msg: string) => void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("TECHNICAL");
  const [probability, setProbability] = useState(3);
  const [impact, setImpact] = useState(3);
  const [potentialLoss, setPotentialLoss] = useState("0");
  const [mitigation, setMitigation] = useState("");

  const bandVariant = (band: string) =>
    band === "CRITICAL" ? "red" : band === "HIGH" ? "amber" : band === "MEDIUM" ? "indigo" : "default";

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Risk register (probability × impact)</CardTitle>
        <p className="text-xs text-muted-foreground">
          Risks MIGHT happen; blockers ARE happening. A realized risk converts to a blocker and
          starts the SLA escalation clock.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {risks.map((r) => {
          const score = riskScore(r.probability, r.impact);
          const band = riskBand(score);
          return (
            <div key={r.id} id={`risk-${r.id}`} className="rounded border border-border/50 p-2 text-sm scroll-mt-20 target:border-primary">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={bandVariant(band)} dot>
                  {band} · P{r.probability}×I{r.impact}={score}
                </Badge>
                <Badge variant="outline">{r.category.replaceAll("_", " ")}</Badge>
                {r.potentialLossUSD > 0 ? (
                  <span className="tabular meta text-xs text-muted-foreground">
                    exposure {formatMoneyCompact(r.potentialLossUSD)}
                  </span>
                ) : null}
                <span className="font-medium">{r.title}</span>
                <Badge
                  variant={
                    r.status === "REALIZED" ? "red" : r.status === "CLOSED" ? "green" : "outline"
                  }
                >
                  {r.status}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">by {r.raisedByName}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>
              {r.mitigation ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <span className="meta">Mitigation:</span> {r.mitigation}
                </p>
              ) : null}
              {canWrite && (r.status === "OPEN" || r.status === "MITIGATING") ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.status === "OPEN" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await updateRiskStatusAction({
                            riskId: r.id,
                            status: "MITIGATING",
                          });
                          afterAction(result, "Risk marked as mitigating.");
                        })
                      }
                    >
                      Start mitigation
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await updateRiskStatusAction({
                          riskId: r.id,
                          status: "CLOSED",
                        });
                        afterAction(result, "Risk closed.");
                      })
                    }
                  >
                    Close (no longer a threat)
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await realizeRiskAsBlockerAction(r.id);
                        afterAction(result, "Risk realized — blocker created, SLA clock started.");
                      })
                    }
                  >
                    Realized → create blocker
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
        {risks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No risks logged.</p>
        ) : null}

        {canWrite ? (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">Log a risk</p>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Risk title"
              aria-label="Risk title"
            />
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What might happen, and what would it affect…"
              aria-label="Risk description"
            />
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-muted-foreground">
                Category
                <select
                  className="mt-1 block h-9 rounded-md border border-input bg-card px-2 text-sm"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {RISK_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                Exposure (USD)
                <Input
                  type="number"
                  min="0"
                  step="1000"
                  value={potentialLoss}
                  onChange={(e) => setPotentialLoss(e.target.value)}
                  className="w-28"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Probability (1–5)
                <Input
                  type="number"
                  min="1"
                  max="5"
                  value={String(probability)}
                  onChange={(e) => setProbability(Number(e.target.value) || 1)}
                  className="w-24"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Impact (1–5)
                <Input
                  type="number"
                  min="1"
                  max="5"
                  value={String(impact)}
                  onChange={(e) => setImpact(Number(e.target.value) || 1)}
                  className="w-24"
                />
              </label>
              <Badge variant={bandVariant(riskBand(riskScore(probability, impact)))} dot>
                Score {riskScore(probability, impact)} —{" "}
                {riskBand(riskScore(probability, impact))}
              </Badge>
            </div>
            <Textarea
              value={mitigation}
              onChange={(e) => setMitigation(e.target.value)}
              placeholder="Mitigation plan (optional)…"
              aria-label="Mitigation plan"
            />
            <Button
              size="sm"
              disabled={pending || title.trim().length < 3 || description.trim().length < 1}
              onClick={() =>
                startTransition(async () => {
                  const result = await createRiskAction({
                    projectId,
                    title: title.trim(),
                    description: description.trim(),
                    category,
                    probability: Math.min(5, Math.max(1, Math.trunc(probability))),
                    impact: Math.min(5, Math.max(1, Math.trunc(impact))),
                    potentialLossUSD: Math.max(0, Number(potentialLoss) || 0),
                    mitigation: mitigation.trim() || undefined,
                  });
                  afterAction(result, "Risk logged.");
                  setTitle("");
                  setDescription("");
                  setMitigation("");
                })
              }
            >
              Log risk
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
