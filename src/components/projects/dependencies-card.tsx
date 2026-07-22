"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Trash2 } from "lucide-react";
import {
  createDependencyAction,
  deleteDependencyAction,
} from "@/server/actions/dependencies";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, RagBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface UpstreamDep {
  id: string;
  predecessorCode: string | null;
  predecessorTitle: string | null;
  predecessorRag: "RED" | "AMBER" | "GREEN" | null;
  dependencyType: string;
  lagDays: number;
  isCrossSite: boolean;
}

interface LinkableProject {
  id: string;
  code: string;
  title: string;
}

const DEP_TYPES = [
  "FINISH_TO_START",
  "START_TO_START",
  "FINISH_TO_FINISH",
  "START_TO_FINISH",
] as const;

/** Cross-project dependency panel: upstream gates on this project + link form. */
export function DependenciesCard({
  projectId,
  upstreamDeps,
  downstreamDepCount,
  linkableProjects,
  canWrite,
}: {
  projectId: string;
  upstreamDeps: UpstreamDep[];
  downstreamDepCount: number;
  linkableProjects: LinkableProject[];
  canWrite: boolean;
}): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [predecessorId, setPredecessorId] = useState(linkableProjects[0]?.id ?? "");
  const [depType, setDepType] = useState<string>("FINISH_TO_START");
  const [lagDays, setLagDays] = useState("0");

  function afterAction(result: { ok: boolean; error?: string }, msg: string) {
    setFeedback(result.ok ? msg : (result.error ?? "Action failed"));
    if (result.ok) router.refresh();
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4" aria-hidden />
          Cross-project dependencies
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Upstream projects gating this one. Cycles are rejected server-side against the full
          portfolio graph. {downstreamDepCount > 0 ? `${downstreamDepCount} downstream project(s) depend on this one.` : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {upstreamDeps.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-2 rounded border border-border/50 p-2 text-sm">
            <span className="text-muted-foreground">Blocked by</span>
            {d.predecessorCode ? (
              <>
                <span className="meta text-xs">{d.predecessorCode}</span>
                <span className="font-medium">{d.predecessorTitle}</span>
                {d.predecessorRag ? <RagBadge rag={d.predecessorRag} /> : null}
              </>
            ) : (
              <Badge variant="outline">restricted upstream project (another site)</Badge>
            )}
            <Badge variant="indigo">{d.dependencyType.replaceAll("_", " ")}</Badge>
            {d.lagDays !== 0 ? (
              <span className="meta text-xs text-muted-foreground">
                {d.lagDays > 0 ? "+" : ""}
                {d.lagDays}d lag
              </span>
            ) : null}
            {d.isCrossSite ? <Badge variant="amber">cross-site</Badge> : null}
            {canWrite ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 text-destructive"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await deleteDependencyAction(d.id);
                    afterAction(result, "Dependency removed.");
                  })
                }
              >
                <Trash2 className="h-3 w-3" aria-hidden /> Remove
              </Button>
            ) : null}
          </div>
        ))}
        {upstreamDeps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No upstream dependencies.</p>
        ) : null}

        {canWrite && linkableProjects.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2 border-t pt-3">
            <label className="text-xs text-muted-foreground">
              Depends on
              <select
                className="mt-1 block h-9 min-w-56 rounded-md border border-input bg-card px-2 text-sm"
                value={predecessorId}
                onChange={(e) => setPredecessorId(e.target.value)}
              >
                {linkableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {p.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Type
              <select
                className="mt-1 block h-9 rounded-md border border-input bg-card px-2 text-sm"
                value={depType}
                onChange={(e) => setDepType(e.target.value)}
              >
                {DEP_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Lag (days)
              <Input
                type="number"
                min="-365"
                max="365"
                value={lagDays}
                onChange={(e) => setLagDays(e.target.value)}
                className="mt-1 w-24"
              />
            </label>
            <Button
              size="sm"
              disabled={pending || !predecessorId}
              onClick={() =>
                startTransition(async () => {
                  const result = await createDependencyAction({
                    predecessorProjectId: predecessorId,
                    successorProjectId: projectId,
                    dependencyType: depType,
                    lagDays: Math.trunc(Number(lagDays)) || 0,
                  });
                  afterAction(result, "Dependency linked.");
                })
              }
            >
              Link dependency
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
  );
}
