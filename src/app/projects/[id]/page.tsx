import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { fetchProjectDetail } from "@/server/queries";
import { auditHistory } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { AppShell } from "@/components/app-shell";
import { GateStepper } from "@/components/projects/gate-stepper";
import { DependenciesCard } from "@/components/projects/dependencies-card";
import { RaciCard } from "@/components/projects/raci-card";
import { ProjectActions } from "@/components/projects/project-actions";
import { projectReadScope } from "@/lib/rbac";
import { withUserDb } from "@/server/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, RagBadge } from "@/components/ui/badge";
import {
  computeEva,
  computeForecast,
  formatMoney,
  formatMoneyCompact,
  usdToLocal,
} from "@/lib/finance";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const user = await getSession();
  if (!user) redirect("/login");

  const [project, siteName] = await Promise.all([
    fetchProjectDetail(user, params.id),
    user.siteId
      ? prisma.site
          .findUnique({ where: { id: user.siteId }, select: { name: true } })
          .then((s) => s?.name ?? null)
      : Promise.resolve(null),
  ]);
  if (!project) notFound();

  const [audit, linkableProjects] = await Promise.all([
    auditHistory("Project", project.id, 20),
    withUserDb(user, (db) =>
      db.project.findMany({
        where: { ...projectReadScope(user), id: { not: project.id } },
        select: { id: true, code: true, title: true },
        orderBy: { code: "asc" },
      })
    ),
  ]);
  const fin = project.financialDetail;

  const eva = computeEva(
    {
      budgetAtCompletionUSD: project.totalBudgetUSD,
      actualCostUSD: project.totalActualUSD,
      milestones: project.milestones.map((m) => ({
        targetDate: m.targetDate,
        completed: m.status === "COMPLETED",
        weightPercent: m.weightPercent,
      })),
    },
    new Date()
  );

  return (
    <AppShell user={{ name: user.name, role: user.role, siteName }}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{project.title}</h1>
          <RagBadge rag={project.rag} overridden={project.ragOverride !== null} />
          <Badge>{project.status.replaceAll("_", " ")}</Badge>
          <Badge variant="outline">Gate: {project.currentGate.replaceAll("_", " ")}</Badge>
          <span className="font-mono text-xs text-muted-foreground">{project.code}</span>
          <span className="text-xs text-muted-foreground">
            {project.siteName ?? "Group"} · Owner {project.ownerName} ·{" "}
            {formatDate(project.startDate)} → {formatDate(project.targetEndDate)}
          </span>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{project.description}</p>
        {project.ragOverride ? (
          <p className="text-xs text-rag-amber">
            RAG override active ({project.ragOverride}): {project.ragOverrideReason}
          </p>
        ) : null}

        <GateStepper currentGate={project.currentGate} />

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Financials (USD base{fin && fin.localCurrency !== "USD" ? ` · ${fin.localCurrency} local` : ""})</CardTitle>
            </CardHeader>
            <CardContent>
              {fin ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase text-muted-foreground">
                      <th className="py-1"></th>
                      <th className="py-1 text-right">Budget</th>
                      <th className="py-1 text-right">Actual</th>
                      <th className="py-1 text-right">Variance</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    <tr>
                      <td className="py-1">CapEx</td>
                      <td className="py-1 text-right">{formatMoney(fin.capexBudgetUSD)}</td>
                      <td className="py-1 text-right">{formatMoney(fin.capexActualUSD)}</td>
                      <td className="py-1 text-right">
                        {formatMoneyCompact(fin.capexActualUSD - fin.capexBudgetUSD)}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1">OpEx</td>
                      <td className="py-1 text-right">{formatMoney(fin.opexBudgetUSD)}</td>
                      <td className="py-1 text-right">{formatMoney(fin.opexActualUSD)}</td>
                      <td className="py-1 text-right">
                        {formatMoneyCompact(fin.opexActualUSD - fin.opexBudgetUSD)}
                      </td>
                    </tr>
                    <tr className="border-t font-medium">
                      <td className="py-1">Total</td>
                      <td className="py-1 text-right">{formatMoney(project.totalBudgetUSD)}</td>
                      <td className="py-1 text-right">{formatMoney(project.totalActualUSD)}</td>
                      <td className="py-1 text-right">
                        {formatMoneyCompact(project.varianceUSD)}
                        {project.variancePct !== null
                          ? ` (${project.variancePct >= 0 ? "+" : ""}${project.variancePct.toFixed(1)}%)`
                          : ""}
                      </td>
                    </tr>
                    {fin.localCurrency !== "USD" ? (
                      <tr className="text-xs text-muted-foreground">
                        <td className="py-1">Local ({fin.localCurrency})</td>
                        <td className="py-1 text-right">
                          {formatMoney(usdToLocal(project.totalBudgetUSD, fin.fxRateToBase), fin.localCurrency)}
                        </td>
                        <td className="py-1 text-right">
                          {formatMoney(usdToLocal(project.totalActualUSD, fin.fxRateToBase), fin.localCurrency)}
                        </td>
                        <td className="py-1 text-right">@{fin.fxRateToBase}/USD</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              ) : (
                <p className="text-sm text-muted-foreground">No financial baseline recorded.</p>
              )}
              {fin?.sapWBSElement ? (
                <p className="mt-2 text-xs text-muted-foreground">SAP WBS: {fin.sapWBSElement}</p>
              ) : null}
              <p className="tabular mt-2 border-t pt-2 text-xs text-muted-foreground">
                EVA — PV {formatMoneyCompact(eva.plannedValueUSD)} · EV{" "}
                {formatMoneyCompact(eva.earnedValueUSD)} · AC{" "}
                {formatMoneyCompact(eva.actualCostUSD)}
                {eva.spi !== null ? ` · SPI ${eva.spi.toFixed(2)}` : ""}
                {eva.cpi !== null ? ` · CPI ${eva.cpi.toFixed(2)}` : ""}
              </p>
              {(() => {
                const forecast = computeForecast({
                  budgetAtCompletionUSD: project.totalBudgetUSD,
                  earnedValueUSD: eva.earnedValueUSD,
                  actualCostUSD: eva.actualCostUSD,
                });
                return (
                  <p className="tabular mt-1 text-xs text-muted-foreground">
                    Forecast{forecast.basis === "cpi" ? " (CPI-trend)" : " (baseline)"} — EAC{" "}
                    {formatMoneyCompact(forecast.eacUSD)} · ETC{" "}
                    {formatMoneyCompact(forecast.etcUSD)} ·{" "}
                    <span className={forecast.vacUSD < 0 ? "text-rag-red" : "text-rag-green"}>
                      VAC {formatMoneyCompact(forecast.vacUSD)}
                    </span>
                  </p>
                );
              })()}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Milestone timeline</CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                const start = project.startDate.getTime();
                const end = project.targetEndDate.getTime();
                const span = Math.max(1, end - start);
                const now = Date.now();
                const nowPct = Math.min(100, Math.max(0, ((now - start) / span) * 100));
                return (
                  <div className="mb-4">
                    <div className="relative h-2 rounded-full bg-secondary">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-primary/25"
                        style={{ width: `${nowPct}%` }}
                      />
                      {project.milestones.map((m) => {
                        const pct = Math.min(
                          100,
                          Math.max(0, ((m.targetDate.getTime() - start) / span) * 100)
                        );
                        const color =
                          m.status === "COMPLETED"
                            ? "bg-rag-green"
                            : m.status === "DELAYED"
                              ? "bg-rag-red"
                              : "bg-primary";
                        return (
                          <span
                            key={m.id}
                            title={`${m.title} — ${formatDate(m.targetDate)}`}
                            className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card ${color}`}
                            style={{ left: `${pct}%` }}
                          />
                        );
                      })}
                    </div>
                    <div className="meta mt-1.5 flex justify-between text-[10px] text-muted-foreground">
                      <span>{formatDate(project.startDate)}</span>
                      <span>today</span>
                      <span>{formatDate(project.targetEndDate)}</span>
                    </div>
                  </div>
                );
              })()}
              <ul className="space-y-1.5 text-sm">
                {project.milestones.map((m) => (
                  <li key={m.id} className="flex items-center gap-2">
                    <Badge
                      variant={
                        m.status === "COMPLETED" ? "green" : m.status === "DELAYED" ? "red" : "default"
                      }
                      dot
                    >
                      {m.status}
                    </Badge>
                    <span>{m.title}</span>
                    <span className="meta ml-auto text-xs text-muted-foreground">
                      {m.weightPercent}% · due {formatDate(m.targetDate)}
                      {m.actualDate ? ` · done ${formatDate(m.actualDate)}` : ""}
                    </span>
                  </li>
                ))}
                {project.milestones.length === 0 ? (
                  <li className="text-muted-foreground">No milestones defined.</li>
                ) : null}
              </ul>
            </CardContent>
          </Card>
        </div>

        <ProjectActions
          projectId={project.id}
          currentGate={project.currentGate}
          totalBudgetUSD={project.totalBudgetUSD}
          totalActualUSD={project.totalActualUSD}
          risks={project.risks.map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
            category: r.category,
            probability: r.probability,
            impact: r.impact,
            potentialLossUSD: r.potentialLossUSD,
            mitigation: r.mitigation,
            status: r.status,
            raisedByName: r.raisedByName,
          }))}
          blockers={project.blockers.map((b) => ({
            id: b.id,
            title: b.title,
            severity: b.severity,
            status: b.status,
            escalationLevel: b.escalationLevel,
            createdAt: b.createdAt.toISOString(),
            raisedByName: b.raisedByName,
          }))}
          scopeChanges={project.scopeChangeRequests.map((s) => ({
            id: s.id,
            description: s.scopeDeltaDescription,
            budgetImpactUSD: s.budgetImpactUSD,
            timeImpactDays: s.timeImpactDays,
            status: s.status,
            requestedByName: s.requestedByName,
          }))}
          canSteer={user.role === "GROUP_IT_MANAGER" || user.role === "SYSTEM_ADMIN"}
          canWrite={user.role !== "EXEC_STAKEHOLDER"}
        />

        <RaciCard
          projectId={project.id}
          raci={project.raci}
          canWrite={user.role !== "EXEC_STAKEHOLDER"}
        />

        <DependenciesCard
          projectId={project.id}
          upstreamDeps={project.upstreamDeps}
          downstreamDepCount={project.downstreamDepCount}
          linkableProjects={linkableProjects}
          canWrite={user.role !== "EXEC_STAKEHOLDER"}
        />

        <Card>
          <CardHeader>
            <CardTitle>Audit Trail</CardTitle>
            <p className="text-xs text-muted-foreground">
              Showing last {audit.length} state-changing actions (COBIT 2019).
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="th-band text-left">
                    <th className="px-3 py-2">Timestamp</th>
                    <th className="px-3 py-2">Actor</th>
                    <th className="px-3 py-2">IP Address</th>
                    <th className="px-3 py-2">Action</th>
                    <th className="px-3 py-2">Old state</th>
                    <th className="px-3 py-2">New state</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id} className="border-t align-top hover:bg-secondary/40">
                      <td className="meta tabular whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {a.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-medium">
                        {a.user?.name ?? "System"}
                      </td>
                      <td className="meta whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {a.ipAddress ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="indigo">{a.action}</Badge>
                      </td>
                      <td className="max-w-[220px] px-3 py-2">
                        {a.previous ? (
                          <span className="meta block truncate rounded bg-secondary px-1.5 py-0.5 text-[10px]">
                            {JSON.stringify(a.previous)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="max-w-[220px] px-3 py-2">
                        {a.next ? (
                          <span className="meta block truncate rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                            {JSON.stringify(a.next)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {audit.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                        No audit entries.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
