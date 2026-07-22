"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import type { PortfolioRow } from "@/server/queries";
import { refreshProjectCache, readProjectCache } from "@/offline/sync-engine";
import type { CachedProject } from "@/offline/db";
import { RagBadge, RagStripe, Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatMoneyCompact } from "@/lib/finance";
import { formatDate } from "@/lib/utils";

type RagFilter = "ALL" | "RED" | "AMBER" | "GREEN" | "AT_RISK";

interface DisplayRow {
  id: string;
  code: string;
  title: string;
  siteName: string | null;
  scopeType: "GROUP" | "SITE";
  status: string;
  currentGate: string;
  rag: "RED" | "AMBER" | "GREEN";
  ragIsOverridden: boolean;
  targetEndDate: string;
  totalBudgetUSD: number;
  totalActualUSD: number;
  openBlockerCount: number;
}

function toDisplay(rows: PortfolioRow[]): DisplayRow[] {
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    title: r.title,
    siteName: r.siteName,
    scopeType: r.scopeType,
    status: r.status,
    currentGate: r.currentGate,
    rag: r.rag,
    ragIsOverridden: r.ragOverride !== null,
    targetEndDate: new Date(r.targetEndDate).toISOString(),
    totalBudgetUSD: r.totalBudgetUSD,
    totalActualUSD: r.totalActualUSD,
    openBlockerCount: r.openBlockerCount,
  }));
}

function fromCache(rows: CachedProject[]): DisplayRow[] {
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    title: r.title,
    siteName: r.siteName,
    scopeType: r.scopeType,
    status: r.status,
    currentGate: r.currentGate,
    rag: r.rag,
    ragIsOverridden: r.ragIsOverridden,
    targetEndDate: r.targetEndDate,
    totalBudgetUSD: r.totalBudgetUSD,
    totalActualUSD: r.totalActualUSD,
    openBlockerCount: r.openBlockerCount,
  }));
}

/**
 * Portfolio grid with instant client-side filtering.
 * On mount it seeds the IndexedDB read cache; when offline it serves from it.
 */
export function PortfolioTable({ rows }: { rows: PortfolioRow[] }): JSX.Element {
  const [query, setQuery] = useState("");
  const [ragFilter, setRagFilter] = useState<RagFilter>("ALL");
  const [offlineRows, setOfflineRows] = useState<DisplayRow[] | null>(null);

  useEffect(() => {
    // Seed the offline cache with the freshest server data.
    const cache: CachedProject[] = rows.map((r) => ({
      id: r.id,
      code: r.code,
      title: r.title,
      description: r.description,
      scopeType: r.scopeType,
      siteId: r.siteId,
      siteName: r.siteName,
      status: r.status,
      currentGate: r.currentGate,
      rag: r.rag,
      ragIsOverridden: r.ragOverride !== null,
      syncVersion: r.syncVersion,
      startDate: new Date(r.startDate).toISOString(),
      targetEndDate: new Date(r.targetEndDate).toISOString(),
      totalBudgetUSD: r.totalBudgetUSD,
      totalActualUSD: r.totalActualUSD,
      openBlockerCount: r.openBlockerCount,
      cachedAt: new Date().toISOString(),
    }));
    refreshProjectCache(cache).catch(() => {
      // IndexedDB unavailable (private mode) — online mode still works.
    });
  }, [rows]);

  useEffect(() => {
    function loadFromCache() {
      readProjectCache()
        .then((cached) => setOfflineRows(fromCache(cached)))
        .catch(() => setOfflineRows(null));
    }
    const onOffline = () => loadFromCache();
    const onOnline = () => setOfflineRows(null);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    if (!navigator.onLine) loadFromCache();
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const source = offlineRows ?? toDisplay(rows);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter((r) => {
      if (ragFilter === "AT_RISK" && r.rag === "GREEN") return false;
      if ((ragFilter === "RED" || ragFilter === "AMBER" || ragFilter === "GREEN") && r.rag !== ragFilter) {
        return false;
      }
      if (!q) return true;
      return (
        r.code.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        (r.siteName ?? "group").toLowerCase().includes(q)
      );
    });
  }, [source, query, ragFilter]);

  const filterButtons: { key: RagFilter; label: string }[] = [
    { key: "AT_RISK", label: "Red/Amber first" },
    { key: "ALL", label: "All" },
    { key: "RED", label: "Red" },
    { key: "AMBER", label: "Amber" },
    { key: "GREEN", label: "Green" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search
            className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by code, title, site…"
            className="w-64 pl-8"
            aria-label="Filter projects"
          />
        </div>
        {filterButtons.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={ragFilter === f.key ? "default" : "outline"}
            onClick={() => setRagFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
        {offlineRows ? <Badge variant="amber">Offline — cached data</Badge> : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} of {source.length} projects
        </span>
      </div>

      <div className="glass overflow-x-auto rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="th-band border-b text-left">
              <th className="w-2 px-2 py-2"></th>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Project</th>
              <th className="px-3 py-2">Site</th>
              <th className="px-3 py-2">Gate</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">RAG</th>
              <th className="px-3 py-2 text-right">Budget</th>
              <th className="px-3 py-2 text-right">Actual</th>
              <th className="px-3 py-2 text-right">Blockers</th>
              <th className="px-3 py-2">Target end</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b border-border/60 hover:bg-secondary/40">
                <td className="px-2 py-2">
                  <RagStripe rag={r.rag} />
                </td>
                <td className="meta px-3 py-2 text-xs text-muted-foreground">{r.code}</td>
                <td className="px-3 py-2">
                  <Link href={`/projects/${r.id}`} className="font-medium hover:text-primary">
                    {r.title}
                  </Link>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{r.siteName ?? "Group"}</td>
                <td className="px-3 py-2 text-xs">{r.currentGate.replaceAll("_", " ")}</td>
                <td className="px-3 py-2 text-xs">{r.status.replaceAll("_", " ")}</td>
                <td className="px-3 py-2">
                  <RagBadge rag={r.rag} overridden={r.ragIsOverridden} />
                </td>
                <td className="tabular px-3 py-2 text-right">
                  {formatMoneyCompact(r.totalBudgetUSD)}
                </td>
                <td className="tabular px-3 py-2 text-right">
                  {formatMoneyCompact(r.totalActualUSD)}
                </td>
                <td className="tabular px-3 py-2 text-right">
                  {r.openBlockerCount > 0 ? (
                    <Badge variant="red">{r.openBlockerCount}</Badge>
                  ) : (
                    "0"
                  )}
                </td>
                <td className="px-3 py-2 text-xs">{formatDate(r.targetEndDate)}</td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-muted-foreground">
                  No projects match the current filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
