"use client";

import { getOfflineDb, type CachedProject, type OutboxItem } from "@/offline/db";
import type { SyncOpResult } from "@/lib/validators";

/**
 * Delta-sync engine for high-latency / unstable WAN links.
 *
 * Behavior:
 *  - Mutations enqueue to the IndexedDB outbox and apply optimistically to the
 *    local cache (instant UI).
 *  - flushOutbox() drains pending ops to POST /api/sync in order, honoring the
 *    server's per-op verdicts (applied / duplicate / conflict / rejected).
 *  - Conflicted ops keep the server's authoritative state for the rebase UI;
 *    they are never silently retried (no lost-update masking).
 *  - Exponential backoff caps retry pressure on degraded links.
 */

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 50;

export interface SyncSummary {
  attempted: number;
  applied: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  networkError: boolean;
}

export function newClientOpId(): string {
  return crypto.randomUUID();
}

export async function enqueueMutation(
  kind: OutboxItem["kind"],
  payload: unknown
): Promise<string> {
  const db = getOfflineDb();
  const clientOpId = newClientOpId();
  await db.outbox.add({
    clientOpId,
    kind,
    payload,
    occurredAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
    lastError: null,
    serverState: null,
  });
  return clientOpId;
}

/** Optimistically patch the cached project so offline UI reflects the edit. */
export async function applyOptimisticProjectPatch(
  projectId: string,
  patch: Partial<Pick<CachedProject, "title" | "description" | "status" | "currentGate" | "targetEndDate">>
): Promise<void> {
  const db = getOfflineDb();
  await db.projectCache.update(projectId, patch);
}

export async function pendingCount(): Promise<number> {
  const db = getOfflineDb();
  return db.outbox.where("status").anyOf(["pending", "conflict", "rejected"]).count();
}

/** Replace the local read-model cache with fresh server data. */
export async function refreshProjectCache(projects: CachedProject[]): Promise<void> {
  const db = getOfflineDb();
  await db.transaction("rw", db.projectCache, async () => {
    await db.projectCache.clear();
    await db.projectCache.bulkAdd(projects);
  });
}

export async function readProjectCache(): Promise<CachedProject[]> {
  const db = getOfflineDb();
  return db.projectCache.toArray();
}

/**
 * Drain the outbox. Safe to call repeatedly (on 'online' events, on an
 * interval, after every mutation) — a module-level latch prevents concurrent
 * flushes from double-sending.
 */
let flushing = false;

export async function flushOutbox(): Promise<SyncSummary> {
  const summary: SyncSummary = {
    attempted: 0,
    applied: 0,
    duplicates: 0,
    conflicts: 0,
    rejected: 0,
    networkError: false,
  };

  if (flushing) return summary;
  if (typeof navigator !== "undefined" && !navigator.onLine) return summary;

  flushing = true;
  try {
    const db = getOfflineDb();
    // Sort BEFORE limiting — Dexie's limit() applies in index order, which
    // would replay mutations out of chronological sequence.
    const pending = await db.outbox.where("status").equals("pending").sortBy("occurredAt");
    const batch = pending.slice(0, BATCH_SIZE);

    if (batch.length === 0) return summary;
    summary.attempted = batch.length;

    await db.outbox.bulkPut(batch.map((op) => ({ ...op, status: "syncing" as const })));

    let response: Response;
    try {
      response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operations: batch.map((op) => ({
            kind: op.kind,
            clientOpId: op.clientOpId,
            occurredAt: op.occurredAt,
            data: op.payload,
          })),
        }),
      });
    } catch {
      // WAN dropped mid-flush: return everything to pending with backoff count.
      await db.outbox.bulkPut(
        batch.map((op) => ({
          ...op,
          status: "pending" as const,
          attempts: op.attempts + 1,
          lastError: "Network unreachable",
        }))
      );
      summary.networkError = true;
      return summary;
    }

    if (!response.ok) {
      const retriable = response.status >= 500 || response.status === 429;
      await db.outbox.bulkPut(
        batch.map((op) => ({
          ...op,
          status:
            retriable && op.attempts + 1 < MAX_ATTEMPTS
              ? ("pending" as const)
              : ("rejected" as const),
          attempts: op.attempts + 1,
          lastError: `HTTP ${response.status}`,
        }))
      );
      summary.networkError = retriable;
      return summary;
    }

    const body = (await response.json()) as { results: SyncOpResult[] };
    const byId = new Map(body.results.map((r) => [r.clientOpId, r]));

    for (const op of batch) {
      const result = byId.get(op.clientOpId);
      if (!result) {
        await db.outbox.update(op.clientOpId, {
          status: "pending",
          attempts: op.attempts + 1,
          lastError: "No server verdict for op",
        });
        continue;
      }
      switch (result.status) {
        case "applied":
          summary.applied += 1;
          await db.outbox.delete(op.clientOpId);
          break;
        case "duplicate":
          summary.duplicates += 1;
          await db.outbox.delete(op.clientOpId);
          break;
        case "conflict":
          summary.conflicts += 1;
          await db.outbox.update(op.clientOpId, {
            status: "conflict",
            lastError: result.message ?? "Version conflict",
            serverState: result.serverState ?? null,
          });
          break;
        case "rejected":
          summary.rejected += 1;
          await db.outbox.update(op.clientOpId, {
            status: "rejected",
            lastError: result.message ?? "Rejected by server",
          });
          break;
      }
    }

    return summary;
  } finally {
    flushing = false;
  }
}

/** Discard a conflicted/rejected op after the user has reviewed it. */
export async function discardOutboxItem(clientOpId: string): Promise<void> {
  const db = getOfflineDb();
  await db.outbox.delete(clientOpId);
}
