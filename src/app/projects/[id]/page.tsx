import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { fetchProjectDetail } from "@/server/queries";
import { auditHistory } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { AppShell } from "@/components/app-shell";
import { ProjectActions } from "@/components/projects/project-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, RagBadge } from "@/components/ui/badge";
import { formatMoney, formatMoneyCompact, usdToLocal } from "@/lib/finance";
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

  const audit = await auditHistory("Project", project.id, 20);
  const fin = project.financialDetail;

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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Milestones</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-sm">
                {project.milestones.map((m) => (
                  <li key={m.id} className="flex items-center gap-2">
                    <Badge
                      variant={
                        m.status === "COMPLETED" ? "green" : m.status === "DELAYED" ? "red" : "default"
                      }
                    >
                      {m.status}
                    </Badge>
                    <span>{m.title}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
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

        <Card>
          <CardHeader>
            <CardTitle>Audit trail (COBIT 2019)</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-xs">
              {audit.map((a) => (
                <li key={a.id} className="flex gap-2 text-muted-foreground">
                  <span className="tabular shrink-0">{a.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                  <Badge variant="outline">{a.action}</Badge>
                  <span>{a.user?.name ?? "System"}</span>
                  <span className="truncate">
                    {a.next ? JSON.stringify(a.next).slice(0, 120) : ""}
                  </span>
                </li>
              ))}
              {audit.length === 0 ? <li className="text-muted-foreground">No audit entries.</li> : null}
            </ul>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
