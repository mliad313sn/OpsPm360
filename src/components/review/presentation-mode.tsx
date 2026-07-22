"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import type { PortfolioRow, WarRoomSignals } from "@/server/queries";
import { recordDecisionAction } from "@/server/actions/meetings";
import { Badge, RagBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { formatMoneyCompact } from "@/lib/finance";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

/**
 * Site-by-Site Executive Review (SRS: Presentation Engine).
 *  ←/→ switch site · ↑/↓ walk projects within the site (0 = site overview)
 *  F fullscreen · A quick action capture · Esc leave fullscreen
 * All data comes from the same RLS-scoped read models as the dashboards; the
 * quick action drawer records into the open meeting's audited decision ledger.
 */

interface SiteGroup {
  name: string;
  rows: PortfolioRow[];
}

export function PresentationMode({
  rows,
  signals,
  meetingId,
  canSteer,
}: {
  rows: PortfolioRow[];
  signals: WarRoomSignals;
  meetingId: string | null;
  canSteer: boolean;
}): JSX.Element {
  const sites = useMemo<SiteGroup[]>(() => {
    const map = new Map<string, PortfolioRow[]>();
    for (const r of rows.filter((x) => x.status !== "COMPLETED")) {
      const key = r.siteName ?? "Group IT";
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    const order: Record<string, number> = { RED: 0, AMBER: 1, GREEN: 2 };
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, list]) => ({
        name,
        rows: list.sort((a, b) => (order[a.rag] ?? 3) - (order[b.rag] ?? 3)),
      }));
  }, [rows]);

  const [siteIdx, setSiteIdx] = useState(0);
  // slideIdx: 0 = site overview, 1..n = project deep-dives
  const [slideIdx, setSlideIdx] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionText, setActionText] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const site = sites[siteIdx] ?? null;
  const project = site && slideIdx > 0 ? (site.rows[slideIdx - 1] ?? null) : null;

  const goSite = useCallback(
    (delta: number) => {
      setSiteIdx((i) => Math.min(Math.max(0, i + delta), Math.max(0, sites.length - 1)));
      setSlideIdx(0);
    },
    [sites.length]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT") return;
      switch (e.key) {
        case "ArrowRight":
          goSite(1);
          break;
        case "ArrowLeft":
          goSite(-1);
          break;
        case "ArrowDown":
          setSlideIdx((i) => Math.min(i + 1, site?.rows.length ?? 0));
          break;
        case "ArrowUp":
          setSlideIdx((i) => Math.max(0, i - 1));
          break;
        case "f":
        case "F":
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen().catch(() => {});
          break;
        case "a":
        case "A":
          if (canSteer) setDrawerOpen((v) => !v);
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goSite, site?.rows.length, canSteer]);

  if (!site) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">No active projects to review.</p>
      </main>
    );
  }

  const totBudget = site.rows.reduce((a, r) => a + r.totalBudgetUSD, 0);
  const totActual = site.rows.reduce((a, r) => a + r.totalActualUSD, 0);
  const red = site.rows.filter((r) => r.rag === "RED").length;
  const amber = site.rows.filter((r) => r.rag === "AMBER").length;
  const critical = site.rows.reduce((a, r) => a + r.criticalBlockerCount, 0);
  const siteCodes = new Set(site.rows.map((r) => r.code));
  const siteRisks = signals.topRisks.filter((r) => siteCodes.has(r.projectCode)).slice(0, 3);
  const siteDeps = signals.dependencyAlerts
    .filter((d) => siteCodes.has(d.successorCode))
    .slice(0, 3);

  return (
    <main className="flex min-h-screen flex-col bg-background">
      {/* Chrome */}
      <header className="flex items-center gap-3 border-b bg-card px-4 py-2">
        <Link href="/meeting" className="meta text-xs text-muted-foreground hover:text-foreground">
          <X className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          Exit review
        </Link>
        <nav aria-label="Sites" className="flex flex-1 items-center justify-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => goSite(-1)} aria-label="Previous site">
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          {sites.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => {
                setSiteIdx(i);
                setSlideIdx(0);
              }}
              className={cn(
                "meta rounded-full px-3 py-1 text-xs",
                i === siteIdx
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary"
              )}
            >
              {s.name}
            </button>
          ))}
          <Button variant="ghost" size="icon" onClick={() => goSite(1)} aria-label="Next site">
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </nav>
        <span className="meta hidden text-[10px] text-muted-foreground md:block">
          ←→ site · ↑↓ project · F fullscreen{canSteer ? " · A action" : ""}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle fullscreen"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen().catch(() => {});
          }}
        >
          <Maximize2 className="h-4 w-4" aria-hidden />
        </Button>
      </header>

      {/* Slide */}
      <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center p-8">
        {slideIdx === 0 ? (
          <div>
            <p className="stat-label">Site overview · {slideIdx}/{site.rows.length}</p>
            <h1 className="mt-1 font-display text-5xl font-bold">{site.name}</h1>
            <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div className="glass p-5">
                <p className="stat-label">Spend / budget</p>
                <p className="tabular mt-1 font-display text-3xl font-bold">
                  {formatMoneyCompact(totActual)}
                  <span className="text-lg text-muted-foreground"> / {formatMoneyCompact(totBudget)}</span>
                </p>
              </div>
              <div className="glass p-5">
                <p className="stat-label">Projects</p>
                <p className="tabular mt-1 font-display text-3xl font-bold">{site.rows.length}</p>
              </div>
              <div className="glass p-5">
                <p className="stat-label">At risk</p>
                <p className="tabular mt-1 font-display text-3xl font-bold">
                  <span className="text-rag-red">{red}</span>
                  <span className="text-lg text-muted-foreground"> red · </span>
                  <span className="text-rag-amber">{amber}</span>
                  <span className="text-lg text-muted-foreground"> amber</span>
                </p>
              </div>
              <div className="glass p-5">
                <p className="stat-label">Critical blockers</p>
                <p
                  className={cn(
                    "tabular mt-1 font-display text-3xl font-bold",
                    critical > 0 && "text-rag-red"
                  )}
                >
                  {critical}
                </p>
              </div>
            </div>
            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              <div className="glass p-5">
                <p className="stat-label">Top risks</p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {siteRisks.map((r) => (
                    <li key={r.id} className="flex items-center gap-2">
                      <Badge variant={r.score >= 15 ? "red" : "amber"} dot>
                        {r.score}
                      </Badge>
                      <span className="meta text-xs text-muted-foreground">{r.projectCode}</span>
                      {r.title}
                    </li>
                  ))}
                  {siteRisks.length === 0 ? (
                    <li className="text-muted-foreground">No open risks.</li>
                  ) : null}
                </ul>
              </div>
              <div className="glass p-5">
                <p className="stat-label">Blocked dependencies</p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {siteDeps.map((d) => (
                    <li key={d.id} className="flex items-center gap-2">
                      <span className="meta text-xs">{d.successorCode}</span>
                      <span className="text-muted-foreground">blocked by</span>
                      <span className="meta text-xs">{d.predecessorCode ?? "restricted"}</span>
                      {d.predecessorRag ? <RagBadge rag={d.predecessorRag} /> : null}
                    </li>
                  ))}
                  {siteDeps.length === 0 ? (
                    <li className="text-muted-foreground">No blocked dependencies.</li>
                  ) : null}
                </ul>
              </div>
            </div>
          </div>
        ) : project ? (
          <div>
            <p className="stat-label">
              {site.name} · project {slideIdx}/{site.rows.length}
            </p>
            <div className="mt-1 flex items-center gap-4">
              <h1 className="font-display text-4xl font-bold">{project.title}</h1>
              <RagBadge rag={project.rag} overridden={project.ragOverride !== null} />
            </div>
            <p className="meta mt-2 text-sm text-muted-foreground">
              {project.code} · gate {project.currentGate.replaceAll("_", " ")} · owner{" "}
              {project.ownerName} · due {formatDate(project.targetEndDate)}
            </p>
            <p className="mt-4 max-w-3xl text-lg text-muted-foreground">{project.description}</p>
            <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div className="glass p-5">
                <p className="stat-label">Spend / budget</p>
                <p className="tabular mt-1 font-display text-2xl font-bold">
                  {formatMoneyCompact(project.totalActualUSD)}
                  <span className="text-base text-muted-foreground">
                    {" "}
                    / {formatMoneyCompact(project.totalBudgetUSD)}
                  </span>
                </p>
              </div>
              <div className="glass p-5">
                <p className="stat-label">Variance</p>
                <p
                  className={cn(
                    "tabular mt-1 font-display text-2xl font-bold",
                    (project.variancePct ?? 0) > 20
                      ? "text-rag-red"
                      : (project.variancePct ?? 0) > 10
                        ? "text-rag-amber"
                        : "text-rag-green"
                  )}
                >
                  {project.variancePct !== null
                    ? `${project.variancePct >= 0 ? "+" : ""}${project.variancePct.toFixed(1)}%`
                    : "—"}
                </p>
              </div>
              <div className="glass p-5">
                <p className="stat-label">Open blockers</p>
                <p
                  className={cn(
                    "tabular mt-1 font-display text-2xl font-bold",
                    project.criticalBlockerCount > 0 && "text-rag-red"
                  )}
                >
                  {project.openBlockerCount}
                  {project.criticalBlockerCount > 0
                    ? ` (${project.criticalBlockerCount} critical)`
                    : ""}
                </p>
              </div>
              <div className="glass p-5">
                <p className="stat-label">Pending scope changes</p>
                <p className="tabular mt-1 font-display text-2xl font-bold">
                  {project.pendingScopeChanges}
                </p>
              </div>
            </div>
            <Link
              href={`/projects/${project.id}`}
              className="mt-6 inline-block text-sm text-primary underline-offset-4 hover:underline"
            >
              Open full project record →
            </Link>
          </div>
        ) : null}
      </section>

      {/* Quick action drawer */}
      {drawerOpen && canSteer ? (
        <div className="border-t bg-card p-4">
          <div className="mx-auto flex max-w-5xl flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <p className="stat-label">
                Action capture — {project ? project.code : `${site.name} (site level)`}
                {!meetingId ? " · start a War Room session to record" : ""}
              </p>
              <Textarea
                value={actionText}
                onChange={(e) => setActionText(e.target.value)}
                placeholder="Decision or action agreed in the room…"
                className="mt-1"
              />
            </div>
            <Button
              disabled={pending || !meetingId || actionText.trim().length < 3 || !project}
              onClick={() =>
                startTransition(async () => {
                  if (!meetingId || !project) return;
                  const result = await recordDecisionAction({
                    meetingId,
                    projectId: project.id,
                    decisionType: "NOTE",
                    actionTaken: actionText.trim(),
                  });
                  setFeedback(
                    result.ok ? "Recorded in the decision ledger." : (result.error ?? "Failed")
                  );
                  if (result.ok) setActionText("");
                })
              }
            >
              Record
            </Button>
            <Button variant="ghost" onClick={() => setDrawerOpen(false)}>
              Close
            </Button>
            {feedback ? (
              <p role="status" aria-live="polite" className="w-full text-xs text-muted-foreground">
                {feedback}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
