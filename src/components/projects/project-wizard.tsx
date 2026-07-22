"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";
import { createProjectAction } from "@/server/actions/projects";
import { createProjectSchema, type CobitChecklist } from "@/lib/validators";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";

interface SiteOption {
  id: string;
  name: string;
  code: string;
  country: string;
}

interface MilestoneDraft {
  title: string;
  targetDate: string;
  weightPercent: number;
}

const STEPS = ["Context & Site", "COBIT 2019 Checklist", "Financials", "Milestones", "Review"] as const;

const COBIT_ITEMS: { key: keyof Omit<CobitChecklist, "notes">; label: string }[] = [
  { key: "edm01_governanceFramework", label: "EDM01 — Aligned with IT governance framework" },
  { key: "apo12_riskAssessed", label: "APO12 — IT risk assessment completed" },
  { key: "apo13_securityReviewed", label: "APO13 — Information security review done" },
  { key: "bai01_benefitsDefined", label: "BAI01 — Business benefits & KPIs defined" },
  { key: "dss04_continuityConsidered", label: "DSS04 — Continuity/DR impact considered" },
];

export function ProjectWizard({
  sites,
  canCreateGroupScope,
  defaultSiteId,
}: {
  sites: SiteOption[];
  canCreateGroupScope: boolean;
  defaultSiteId: string | null;
}): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [scopeType, setScopeType] = useState<"GROUP" | "SITE">(
    canCreateGroupScope ? "GROUP" : "SITE"
  );
  const [siteId, setSiteId] = useState<string>(defaultSiteId ?? sites[0]?.id ?? "");
  const [startDate, setStartDate] = useState("");
  const [targetEndDate, setTargetEndDate] = useState("");

  const [cobit, setCobit] = useState<CobitChecklist>({
    edm01_governanceFramework: false,
    apo12_riskAssessed: false,
    apo13_securityReviewed: false,
    bai01_benefitsDefined: false,
    dss04_continuityConsidered: false,
  });

  const [capex, setCapex] = useState("0");
  const [opex, setOpex] = useState("0");
  const [currency, setCurrency] = useState<"USD" | "EUR" | "XOF">("USD");
  const [fxRate, setFxRate] = useState("1");
  const [wbs, setWbs] = useState("");

  const [milestones, setMilestones] = useState<MilestoneDraft[]>([
    { title: "", targetDate: "", weightPercent: 100 },
  ]);

  const weightTotal = milestones.reduce((acc, m) => acc + (m.weightPercent || 0), 0);

  function buildPayload(): unknown {
    return {
      title: title.trim(),
      description: description.trim(),
      scopeType,
      siteId: scopeType === "GROUP" ? null : siteId || null,
      startDate,
      targetEndDate,
      cobitChecklist: cobit,
      financials: {
        capexBudgetUSD: Number(capex) || 0,
        opexBudgetUSD: Number(opex) || 0,
        localCurrency: currency,
        fxRateToBase: Number(fxRate) || 1,
        sapWBSElement: wbs.trim() || undefined,
      },
      milestones: milestones
        .filter((m) => m.title.trim() && m.targetDate)
        .map((m) => ({
          title: m.title.trim(),
          targetDate: m.targetDate,
          weightPercent: Math.trunc(m.weightPercent) || 0,
        })),
    };
  }

  function validateCurrentStep(): string | null {
    if (step === 0) {
      if (title.trim().length < 3) return "Title must be at least 3 characters.";
      if (!description.trim()) return "Description is required.";
      if (scopeType === "SITE" && !siteId) return "Select a site.";
      if (!startDate || !targetEndDate) return "Start and target end dates are required.";
      if (new Date(targetEndDate) <= new Date(startDate)) {
        return "Target end date must be after start date.";
      }
    }
    if (step === 2) {
      if (currency !== "USD" && (Number(fxRate) || 0) <= 0) {
        return "FX rate must be positive for non-USD currencies.";
      }
    }
    if (step === 3) {
      const filled = milestones.filter((m) => m.title.trim() && m.targetDate);
      if (filled.length > 0) {
        const total = filled.reduce((acc, m) => acc + (Math.trunc(m.weightPercent) || 0), 0);
        if (total !== 100) return `Milestone weights must sum to 100% (currently ${total}%).`;
      }
    }
    return null;
  }

  function next() {
    const problem = validateCurrentStep();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function submit() {
    const payload = buildPayload();
    const check = createProjectSchema.safeParse(payload);
    if (!check.success) {
      setError(check.error.issues[0]?.message ?? "Validation failed");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createProjectAction(payload);
      if (result.ok) {
        router.push(`/projects/${result.data.projectId}`);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={
              i === step
                ? "rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground"
                : i < step
                  ? "rounded-full bg-secondary px-3 py-1 text-rag-green"
                  : "rounded-full bg-secondary px-3 py-1 text-muted-foreground"
            }
          >
            {i < step ? <Check className="mr-1 inline h-3 w-3" aria-hidden /> : `${i + 1}. `}
            {label}
          </li>
        ))}
      </ol>

      <Card>
        <CardHeader>
          <CardTitle>{STEPS[step]}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {step === 0 ? (
            <>
              <label className="block space-y-1 text-xs text-muted-foreground">
                Project title
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="block space-y-1 text-xs text-muted-foreground">
                Business context / description
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                />
              </label>
              <div className="flex gap-2">
                {canCreateGroupScope ? (
                  <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                    Scope
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={scopeType}
                      onChange={(e) => setScopeType(e.target.value as "GROUP" | "SITE")}
                    >
                      <option value="GROUP">Group IT</option>
                      <option value="SITE">Site IT</option>
                    </select>
                  </label>
                ) : null}
                {scopeType === "SITE" ? (
                  <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                    Site
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={siteId}
                      onChange={(e) => setSiteId(e.target.value)}
                    >
                      {sites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.country})
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <div className="flex gap-2">
                <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                  Start date
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </label>
                <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                  Target end date
                  <Input
                    type="date"
                    value={targetEndDate}
                    onChange={(e) => setTargetEndDate(e.target.value)}
                  />
                </label>
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <div className="space-y-2">
              {COBIT_ITEMS.map((item) => (
                <label key={item.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={cobit[item.key]}
                    onChange={(e) => setCobit({ ...cobit, [item.key]: e.target.checked })}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                  />
                  {item.label}
                </label>
              ))}
              <label className="block space-y-1 text-xs text-muted-foreground">
                Compliance notes (optional)
                <Textarea
                  value={cobit.notes ?? ""}
                  onChange={(e) => setCobit({ ...cobit, notes: e.target.value })}
                />
              </label>
            </div>
          ) : null}

          {step === 2 ? (
            <>
              <div className="flex gap-2">
                <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                  CapEx budget (USD)
                  <Input
                    type="number"
                    min="0"
                    step="1000"
                    value={capex}
                    onChange={(e) => setCapex(e.target.value)}
                  />
                </label>
                <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                  OpEx budget (USD)
                  <Input
                    type="number"
                    min="0"
                    step="1000"
                    value={opex}
                    onChange={(e) => setOpex(e.target.value)}
                  />
                </label>
              </div>
              <div className="flex gap-2">
                <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                  Local currency
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={currency}
                    onChange={(e) => {
                      const c = e.target.value as "USD" | "EUR" | "XOF";
                      setCurrency(c);
                      if (c === "USD") setFxRate("1");
                      if (c === "XOF" && fxRate === "1") setFxRate("605");
                      if (c === "EUR" && fxRate === "1") setFxRate("0.92");
                    }}
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="XOF">XOF (CFA franc)</option>
                  </select>
                </label>
                <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                  FX rate (local per 1 USD)
                  <Input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={fxRate}
                    disabled={currency === "USD"}
                    onChange={(e) => setFxRate(e.target.value)}
                  />
                </label>
              </div>
              <label className="block space-y-1 text-xs text-muted-foreground">
                SAP WBS element (optional)
                <Input value={wbs} onChange={(e) => setWbs(e.target.value)} placeholder="C.1234.01" />
              </label>
            </>
          ) : null}

          {step === 3 ? (
            <div className="space-y-2">
              {milestones.map((m, i) => (
                <div key={i} className="flex items-end gap-2">
                  <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                    Milestone
                    <Input
                      value={m.title}
                      onChange={(e) =>
                        setMilestones(
                          milestones.map((x, j) => (j === i ? { ...x, title: e.target.value } : x))
                        )
                      }
                    />
                  </label>
                  <label className="w-36 space-y-1 text-xs text-muted-foreground">
                    Target date
                    <Input
                      type="date"
                      value={m.targetDate}
                      onChange={(e) =>
                        setMilestones(
                          milestones.map((x, j) =>
                            j === i ? { ...x, targetDate: e.target.value } : x
                          )
                        )
                      }
                    />
                  </label>
                  <label className="w-20 space-y-1 text-xs text-muted-foreground">
                    Weight %
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={String(m.weightPercent)}
                      onChange={(e) =>
                        setMilestones(
                          milestones.map((x, j) =>
                            j === i ? { ...x, weightPercent: Number(e.target.value) || 0 } : x
                          )
                        )
                      }
                    />
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}
                    disabled={milestones.length === 1}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setMilestones([...milestones, { title: "", targetDate: "", weightPercent: 0 }])
                  }
                >
                  Add milestone
                </Button>
                <span
                  className={
                    weightTotal === 100 ? "text-xs text-rag-green" : "text-xs text-rag-amber"
                  }
                >
                  Weights total: {weightTotal}%
                </span>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Title</dt>
                <dd>{title || "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Scope</dt>
                <dd>
                  {scopeType === "GROUP"
                    ? "Group IT"
                    : (sites.find((s) => s.id === siteId)?.name ?? "—")}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Dates</dt>
                <dd>
                  {startDate || "—"} → {targetEndDate || "—"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Budget</dt>
                <dd className="tabular">
                  CapEx ${Number(capex).toLocaleString()} + OpEx ${Number(opex).toLocaleString()}{" "}
                  {currency !== "USD" ? `(${currency} @ ${fxRate}/USD)` : ""}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">COBIT items confirmed</dt>
                <dd>
                  {COBIT_ITEMS.filter((i) => cobit[i.key]).length} / {COBIT_ITEMS.length}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Milestones</dt>
                <dd>{milestones.filter((m) => m.title.trim() && m.targetDate).length}</dd>
              </div>
            </dl>
          ) : null}

          {error ? (
            <p role="alert" className="text-xs text-rag-red">
              {error}
            </p>
          ) : null}

          <div className="flex justify-between pt-2">
            <Button
              variant="outline"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0 || pending}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button onClick={next}>
                Next <ChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            ) : (
              <Button onClick={submit} disabled={pending}>
                {pending ? "Creating…" : "Create project"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
