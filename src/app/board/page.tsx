import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { fetchPortfolio } from "@/server/queries";
import { prisma } from "@/lib/prisma";
import { GATE_ORDER } from "@/lib/gates";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, RagBadge } from "@/components/ui/badge";
import { formatMoneyCompact } from "@/lib/finance";

export const dynamic = "force-dynamic";

const RAG_SORT: Record<string, number> = { RED: 0, AMBER: 1, GREEN: 2 };

/** Kanban board: site-level execution view grouped by COBIT stage gate. */
export default async function BoardPage(): Promise<JSX.Element> {
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

  const columns = GATE_ORDER.map((gate) => ({
    gate,
    projects: portfolio
      .filter((p) => p.currentGate === gate)
      .sort((a, b) => (RAG_SORT[a.rag] ?? 3) - (RAG_SORT[b.rag] ?? 3)),
  }));

  return (
    <AppShell user={{ name: user.name, role: user.role, siteName }}>
      <div className="space-y-3">
        <h1 className="text-lg font-semibold">Stage-Gate Board</h1>
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
          {columns.map((col) => (
            <Card key={col.gate} className="min-h-[200px]">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground">
                  {col.gate.replaceAll("_", " ")}
                  <Badge variant="outline">{col.projects.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {col.projects.map((p) => (
                  <Link
                    key={p.id}
                    href={`/projects/${p.id}`}
                    className="block rounded border border-border/50 p-2 text-sm transition-colors hover:border-primary/50"
                  >
                    <div className="flex items-center gap-2">
                      <RagBadge rag={p.rag} overridden={p.ragOverride !== null} />
                      <span className="font-mono text-[10px] text-muted-foreground">{p.code}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 font-medium">{p.title}</p>
                    <p className="tabular mt-1 text-xs text-muted-foreground">
                      {p.siteName ?? "Group"} · {formatMoneyCompact(p.totalActualUSD)}/
                      {formatMoneyCompact(p.totalBudgetUSD)}
                      {p.openBlockerCount > 0 ? ` · ${p.openBlockerCount} blk` : ""}
                    </p>
                  </Link>
                ))}
                {col.projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Empty</p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
