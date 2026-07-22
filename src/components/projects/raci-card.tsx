"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserCheck, X } from "lucide-react";
import {
  assignRaciAction,
  listAssignableUsersAction,
  removeRaciAction,
} from "@/server/actions/raci";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface RaciRow {
  id: string;
  userId: string;
  userName: string;
  role: string;
}

const ROLE_META: Record<string, { label: string; hint: string; variant: "indigo" | "red" | "amber" | "default" }> = {
  A: { label: "Accountable", hint: "single sign-off owner; gates need their approval", variant: "red" },
  R: { label: "Responsible", hint: "executes the work", variant: "indigo" },
  C: { label: "Consulted", hint: "SME input required", variant: "amber" },
  I: { label: "Informed", hint: "receives automated updates", variant: "default" },
};

/** Project RACI matrix: who does, who signs, who advises, who is kept informed. */
export function RaciCard({
  projectId,
  raci,
  canWrite,
}: {
  projectId: string;
  raci: RaciRow[];
  canWrite: boolean;
}): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [users, setUsers] = useState<{ id: string; name: string; role: string }[]>([]);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("A");

  useEffect(() => {
    if (!canWrite) return;
    // Closure guard: ignore the resolution if the component unmounted or the
    // project changed while the action was in flight (stale-closure setState).
    let cancelled = false;
    listAssignableUsersAction(projectId)
      .then((r) => {
        if (cancelled || !r.ok) return;
        setUsers(r.data.users);
        setUserId((prev) => prev || (r.data.users[0]?.id ?? ""));
      })
      .catch(() => {
        // Offline / transient failure — the picker just stays empty.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, canWrite]);

  function afterAction(result: { ok: boolean; error?: string }, msg: string) {
    setFeedback(result.ok ? msg : (result.error ?? "Action failed"));
    if (result.ok) router.refresh();
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCheck className="h-4 w-4" aria-hidden />
          RACI accountability matrix
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          One Accountable per project (database-enforced). Gate sign-off requires the Accountable
          or a Group IT Manager; the Accountable gets deep-linked action emails on blockers and
          escalations; Informed users get copies.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {(["A", "R", "C", "I"] as const).map((r) => {
            const meta = ROLE_META[r];
            const members = raci.filter((x) => x.role === r);
            return (
              <div key={r} className="rounded border border-border/50 p-2">
                <div className="flex items-center gap-1.5">
                  <Badge variant={meta?.variant ?? "default"} dot>
                    {r} — {meta?.label}
                  </Badge>
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{meta?.hint}</p>
                <ul className="mt-1.5 space-y-1 text-sm">
                  {members.map((m) => (
                    <li key={m.id} className="flex items-center gap-1.5">
                      {m.userName}
                      {canWrite ? (
                        <button
                          type="button"
                          aria-label={`Remove ${m.userName} from ${meta?.label}`}
                          className="text-muted-foreground hover:text-destructive"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              const result = await removeRaciAction(m.id);
                              afterAction(result, "Assignment removed.");
                            })
                          }
                        >
                          <X className="h-3 w-3" aria-hidden />
                        </button>
                      ) : null}
                    </li>
                  ))}
                  {members.length === 0 ? (
                    <li className="text-xs text-muted-foreground">Unassigned</li>
                  ) : null}
                </ul>
              </div>
            );
          })}
        </div>

        {canWrite ? (
          <div className="flex flex-wrap items-end gap-2 border-t pt-3">
            <label className="text-xs text-muted-foreground">
              Person
              <select
                className="mt-1 block h-9 min-w-48 rounded-md border border-input bg-card px-2 text-sm"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.role.replaceAll("_", " ")})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              RACI role
              <select
                className="mt-1 block h-9 rounded-md border border-input bg-card px-2 text-sm"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {(["A", "R", "C", "I"] as const).map((r) => (
                  <option key={r} value={r}>
                    {r} — {ROLE_META[r]?.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              disabled={pending || !userId}
              onClick={() =>
                startTransition(async () => {
                  const result = await assignRaciAction({ projectId, userId, role });
                  afterAction(
                    result,
                    role === "A" ? "Accountable set (previous A replaced)." : "Assignment added."
                  );
                })
              }
            >
              Assign
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
