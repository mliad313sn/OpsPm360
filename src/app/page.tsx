import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { fetchPortfolio } from "@/server/queries";
import { prisma } from "@/lib/prisma";
import { AppShell } from "@/components/app-shell";
import { PortfolioTable } from "@/components/portfolio-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoneyCompact } from "@/lib/finance";

export const dynamic = "force-dynamic";

export default async function DashboardPage(): Promise<JSX.Element> {
  const user = await getSession();
  if (!user) redirect("/login");

  const [portfolio, siteName] = await Promise.all([
    fetchPortfolio(user),
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
  const openBlockers = portfolio.reduce((acc, p) => acc + p.openBlockerCount, 0);
  const criticalBlockers = portfolio.reduce((acc, p) => acc + p.criticalBlockerCount, 0);

  const metrics: { label: string; value: string; accent?: "red" | "amber" | "green" }[] = [
    { label: "Active projects", value: String(active.length) },
    { label: "Red", value: String(red), accent: "red" },
    { label: "Amber", value: String(amber), accent: "amber" },
    { label: "Green", value: String(green), accent: "green" },
    { label: "Portfolio budget", value: formatMoneyCompact(totalBudget) },
    { label: "Actuals to date", value: formatMoneyCompact(totalActual) },
    {
      label: "Open blockers",
      value: criticalBlockers > 0 ? `${openBlockers} (${criticalBlockers} critical)` : String(openBlockers),
      accent: criticalBlockers > 0 ? "red" : undefined,
    },
  ];

  return (
    <AppShell user={{ name: user.name, role: user.role, siteName }}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {metrics.map((m) => (
            <Card key={m.label}>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-normal text-muted-foreground">
                  {m.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <span
                  className={
                    m.accent === "red"
                      ? "text-2xl font-bold text-rag-red"
                      : m.accent === "amber"
                        ? "text-2xl font-bold text-rag-amber"
                        : m.accent === "green"
                          ? "text-2xl font-bold text-rag-green"
                          : "text-2xl font-bold"
                  }
                >
                  {m.value}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
        <PortfolioTable rows={portfolio} />
      </div>
    </AppShell>
  );
}
