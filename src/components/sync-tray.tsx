"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Cloud, CloudOff, RefreshCw, Trash2, X } from "lucide-react";
import { getOfflineDb, type OutboxItem } from "@/offline/db";
import { discardOutboxItem, resolveConflictKeepMine } from "@/offline/sync-engine";
import type { OfflineSyncState } from "@/offline/use-offline-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** Fields compared in the local-vs-server diff for project.update conflicts. */
const DIFF_FIELDS = ["title", "status", "currentGate", "targetEndDate", "description"] as const;

function ConflictDiff({ op }: { op: OutboxItem }): JSX.Element | null {
  if (op.kind !== "project.update") return null;
  const mine = (op.payload as { patch?: Record<string, unknown> }).patch ?? {};
  const theirs = (op.serverState ?? {}) as Record<string, unknown>;
  const rows = DIFF_FIELDS.filter((f) => mine[f] !== undefined);
  if (rows.length === 0) return null;
  return (
    <table className="mt-1.5 w-full text-[10px]">
      <thead>
        <tr className="th-band text-left">
          <th className="px-1.5 py-0.5">Field</th>
          <th className="px-1.5 py-0.5">Mine (offline)</th>
          <th className="px-1.5 py-0.5">Server</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f} className="border-t align-top">
            <td className="meta px-1.5 py-0.5 text-muted-foreground">{f}</td>
            <td className="px-1.5 py-0.5">{String(mine[f]).slice(0, 60)}</td>
            <td className="px-1.5 py-0.5">{String(theirs[f] ?? "—").slice(0, 60)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const KIND_LABEL: Record<OutboxItem["kind"], string> = {
  "project.update": "Project edit",
  "blocker.create": "New blocker",
  "blocker.resolve": "Blocker resolution",
};

/**
 * Sync indicator + review tray. Conflicted/rejected offline operations are
 * surfaced with their server verdict so the user can consciously discard them
 * (after re-applying their intent) instead of them rotting in the queue.
 */
export function SyncTray({ sync }: { sync: OfflineSyncState }): JSX.Element {
  const [open, setOpen] = useState(false);

  const problemOps =
    useLiveQuery(
      () =>
        getOfflineDb()
          .outbox.where("status")
          .anyOf(["conflict", "rejected", "pending"])
          .toArray(),
      [],
      [] as OutboxItem[]
    ) ?? [];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (problemOps.length > 0 ? setOpen((v) => !v) : void sync.flushNow())}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        title={
          sync.online
            ? "Connected — click to review queue / sync now"
            : "Offline — changes queue locally and sync on reconnect"
        }
      >
        {sync.online ? (
          <Cloud className="h-4 w-4 text-rag-green" aria-hidden />
        ) : (
          <CloudOff className="h-4 w-4 text-rag-amber" aria-hidden />
        )}
        {sync.syncing ? <RefreshCw className="h-3 w-3 animate-spin" aria-hidden /> : null}
        {sync.pendingOps > 0 ? <Badge variant="amber">{sync.pendingOps} queued</Badge> : null}
        {sync.conflictOps > 0 ? <Badge variant="red">{sync.conflictOps} conflicts</Badge> : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-8 z-50 w-96 rounded-lg border bg-card p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <p className="stat-label">Offline sync queue</p>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => void sync.flushNow()}>
                Sync now
              </Button>
              <Button size="icon" variant="ghost" onClick={() => setOpen(false)} aria-label="Close">
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          </div>
          <div className="max-h-72 space-y-2 overflow-auto">
            {problemOps.map((op) => (
              <div key={op.clientOpId} className="rounded-md border p-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      op.status === "pending"
                        ? "amber"
                        : op.status === "conflict"
                          ? "red"
                          : "outline"
                    }
                  >
                    {op.status}
                  </Badge>
                  <span className="font-medium">{KIND_LABEL[op.kind]}</span>
                  <span className="meta ml-auto text-[10px] text-muted-foreground">
                    {op.occurredAt.slice(0, 16).replace("T", " ")}
                  </span>
                </div>
                {op.lastError ? (
                  <p className="mt-1 text-muted-foreground">{op.lastError}</p>
                ) : null}
                {op.status === "conflict" ? (
                  <>
                    <ConflictDiff op={op} />
                    <div className="mt-1.5 flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-6"
                        onClick={() =>
                          void resolveConflictKeepMine(op.clientOpId)
                            .then(() => sync.flushNow())
                            .catch(() => {
                              // IndexedDB write failed (quota/private mode) —
                              // the op stays in conflict state for retry.
                            })
                        }
                      >
                        Keep mine
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-destructive"
                        onClick={() => void discardOutboxItem(op.clientOpId)}
                      >
                        Keep theirs
                      </Button>
                    </div>
                  </>
                ) : op.status === "rejected" ? (
                  <div className="mt-1.5 flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-destructive"
                      onClick={() => void discardOutboxItem(op.clientOpId)}
                    >
                      <Trash2 className="h-3 w-3" aria-hidden /> Discard
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
            {problemOps.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">Queue is empty.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
