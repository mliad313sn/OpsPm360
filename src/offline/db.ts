"use client";

import Dexie, { type EntityTable } from "dexie";

/**
 * IndexedDB layer for offline-first operation at remote mine sites.
 *
 * Two stores:
 *  - projectCache: read-model snapshot for offline browsing.
 *  - outbox: queued mutations awaiting sync, in insertion order.
 */

export interface CachedProject {
  id: string;
  code: string;
  title: string;
  description: string;
  scopeType: "GROUP" | "SITE";
  siteId: string | null;
  siteName: string | null;
  status: string;
  currentGate: string;
  rag: "RED" | "AMBER" | "GREEN";
  ragIsOverridden: boolean;
  syncVersion: number;
  startDate: string; // ISO
  targetEndDate: string; // ISO
  totalBudgetUSD: number;
  totalActualUSD: number;
  openBlockerCount: number;
  cachedAt: string; // ISO
}

export type OutboxStatus = "pending" | "syncing" | "conflict" | "rejected";

export interface OutboxItem {
  clientOpId: string; // UUID, primary key + server idempotency key
  kind: "project.update" | "blocker.create" | "blocker.resolve";
  payload: unknown;
  occurredAt: string; // ISO
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  serverState: unknown | null; // populated on conflict for rebase UX
}

export class OfflineDb extends Dexie {
  projectCache!: EntityTable<CachedProject, "id">;
  outbox!: EntityTable<OutboxItem, "clientOpId">;

  constructor() {
    super("opspm360");
    this.version(1).stores({
      projectCache: "id, code, siteId, rag, status",
      outbox: "clientOpId, status, occurredAt",
    });
  }
}

let instance: OfflineDb | null = null;

/** Lazy singleton — IndexedDB only exists in the browser. */
export function getOfflineDb(): OfflineDb {
  if (typeof window === "undefined") {
    throw new Error("OfflineDb is browser-only; do not import from server code");
  }
  if (!instance) instance = new OfflineDb();
  return instance;
}
