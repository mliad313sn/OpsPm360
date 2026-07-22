import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { fetchAlerts, fetchPortfolio, type AlertItem } from "@/server/queries";
import { prisma } from "@/lib/prisma";
import { AppShell } from "@/components/app-shell";
import { PortfolioTable } from "@/components/portfolio-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RagBadge } from "@/components/ui/badge";
import { formatMoneyCompact } from "@/lib/finance";
import { portfolioHealth } from "@/lib/rag";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ALERT_STYLE: Record<AlertItem["kind"], { label: string; tone: string }> = {
  ESCALATION: { label: "Escalation", tone: "border-l-rag-red text-rag-red" },
  CRITICAL_BLOCKER: { label: "Critical Blocker", tone: "border-l-rag-red text-rag-red" },
  RAG_OVERRIDE: { label: "RAG Override", tone: "border-l-rag-amber text-rag-amber" },
  SCOPE_PENDING: { label: "Scope Change", tone: "border-l-primary text-primary" },
};

export default async function DashboardPage(): Promise<JSX.Element> {
  const user = await getSession();
  if (!user) redirect("/login");

  const [portfolio, alerts, siteName] = await Promise.all([
    fetchPortfolio(user),
    fetchAlerts(user),
    user.siteId
      ? prisma.site
          .findUnique({ where: { id: user.siteId }, select: { name: true } })
          .then((s) => s?.name ?? null)
      : Promise.resolve(null),
  ]);

  const active = portfolio.filter((p) => p.status !== "COMPLETED");
  const red = active.filter((p) => p.rag === "RED").length;
  const amber = active.filter((p) => p.rag === "AMBER").length;
  const green = active.filter((p) => p.rag === "GREEN").length;
  const totalBudget = portfolio.reduce((acc, p) => acc + p.totalBudgetUSD, 0);
  const totalActual = portfolio.reduce((acc, p) => acc + p.totalActualUSD, 0);
  const criticalBlockers = portfolio.reduce((acc, p) => acc + p.criticalBlockerCount, 0);

  // Health summary: RAG mix per site (design: Portfolio Health Summary chart).
  const bySite = new Map<string, { red: number; amber: number; green: number }>();
  for (const p of active) {
    const key = p.siteName ?? "Group";
    const bucket = bySite.get(key) ?? { red: 0, amber: 0, green: 0 };
    if (p.rag === "RED") bucket.red += 1;
    else if (p.rag === "AMBER") bucket.amber += 1;
    else bucket.green += 1;
    bySite.set(key, bucket);
  }
  const siteRows = [...bySite.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const maxCount = Math.max(1, ...siteRows.map(([, v]) => v.red + v.amber + v.green));

  return (
    <AppShell user={{ name: user.name, role: user.role, siteName }}>
      <div className="space-y-4">
        <div>
          <h1 className="font-display text-2xl font-bold">Portfolio Executive Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            High-level overview of {siteName ?? "all sites and Group IT"}.
          </p>
        </div>

        {/* KPI band */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <Card>
            <CardContent className="p-4">
              {(() => {
                const health = portfolioHealth(
                  active.map((p) => ({ rag: p.rag, budgetUSD: p.totalBudgetUSD }))
                );
                return (
                  <>
                    <p className="stat-label">Portfolio health (budget-weighted)</p>
                    <p className="tabular mt-2 flex items-center gap-2 font-display text-2xl font-bold">
                      {health.score.toFixed(0)}
                      <span className="text-sm font-normal text-muted-foreground">/100</span>
                      <RagBadge rag={health.rag} />
                    </p>
                  </>
                );
              })()}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="stat-label">Portfolio budget vs actuals</p>
              <p className="tabular mt-2 font-display text-2xl font-bold">
                {formatMoneyCompact(totalActual)}
                <span className="text-base font-normal text-muted-foreground">
                  {" "}
                  / {formatMoneyCompact(totalBudget)}
                </span>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="stat-label">RAG counts</p>
              <p className="tabular mt-2 font-display text-2xl font-bold">
                <span className="text-rag-red">{red}</span>{" "}
                <span className="text-sm font-normal text-muted-foreground">Red</span>{" "}
                <span className="text-rag-amber">{amber}</span>{" "}
                <span className="text-sm font-normal text-muted-foreground">Amber</span>{" "}
                <span className="text-rag-green">{green}</span>{" "}
                <span className="text-sm font-normal text-muted-foreground">Green</span>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="stat-label">Active projects</p>
              <p className="tabular mt-2 font-display text-2xl font-bold">{active.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="stat-label">Critical blockers</p>
              <p
                className={cn(
                  "tabular mt-2 font-display text-2xl font-bold",
                  criticalBlockers > 0 && "text-rag-red"
                )}
              >
                {criticalBlockers}
                {criticalBlockers > 0 ? (
                  <span className="meta ml-2 rounded-full bg-rag-red/10 px-2 py-0.5 text-[11px] font-medium text-rag-red">
                    Requires action
                  </span>
                ) : null}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <div className="space-y-4">
            {/* Health summary */}
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base">Portfolio Health Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {siteRows.map(([site, v]) => {
                  const total = v.red + v.amber + v.green;
                  return (
                    <div key={site} className="flex items-center gap-3">
                      <span className="meta w-36 shrink-0 truncate text-xs text-muted-foreground">
                        {site}
                      </span>
                      <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="bg-rag-red"
                          style={{ width: `${(v.red / maxCount) * 100}%` }}
                        />
                        <div
                          className="bg-rag-amber"
                          style={{ width: `${(v.amber / maxCount) * 100}%` }}
                        />
                        <div
                          className="bg-rag-green"
                          style={{ width: `${(v.green / maxCount) * 100}%` }}
                        />
                      </div>
                      <span className="tabular meta w-8 text-right text-xs text-muted-foreground">
                        {total}
                      </span>
                    </div>
                  );
                })}
                {siteRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No active projects.</p>
                ) : null}
              </CardContent>
            </Card>

            <PortfolioTable rows={portfolio} />
          </div>

          {/* Alerts rail */}
          <Card className="h-fit">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="font-display text-base">Recent Alerts</CardTitle>
              {alerts.length > 0 ? (
                <span className="meta rounded-full bg-rag-red/10 px-2 py-0.5 text-[11px] font-medium text-rag-red">
                  {alerts.length}
                </span>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-2">
              {alerts.map((a) => {
                const style = ALERT_STYLE[a.kind];
                const [borderTone, textTone] = style.tone.split(" ");
                return (
                  <Link
                    key={a.id}
                    href={`/projects/${a.projectId}`}
                    className={cn(
                      "block rounded-md border border-l-4 bg-card p-3 hover:bg-secondary/50",
                      borderTone
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={cn("meta text-xs font-medium", textTone)}>{style.label}</span>
                      <span className="meta shrink-0 text-[10px] text-muted-foreground">
                        {a.at.toISOString().slice(0, 10)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm">{a.title}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{a.detail}</p>
                  </Link>
                );
              })}
              {alerts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No open alerts. 🎉</p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
