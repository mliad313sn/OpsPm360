"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getOfflineDb } from "@/offline/db";
import { flushOutbox, type SyncSummary } from "@/offline/sync-engine";

export interface OfflineSyncState {
  online: boolean;
  pendingOps: number;
  conflictOps: number;
  syncing: boolean;
  lastSync: SyncSummary | null;
  flushNow: () => Promise<void>;
}

const SYNC_INTERVAL_MS = 30_000;

/**
 * Wires the sync engine to the browser lifecycle:
 *  - flush on mount, on 'online' events, and every 30s while online;
 *  - live outbox counters straight from IndexedDB via Dexie live queries.
 */
export function useOfflineSync(): OfflineSyncState {
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);
  const flushingRef = useRef(false);

  const pendingOps =
    useLiveQuery(() => getOfflineDb().outbox.where("status").equals("pending").count(), [], 0) ?? 0;
  const conflictOps =
    useLiveQuery(
      () => getOfflineDb().outbox.where("status").anyOf(["conflict", "rejected"]).count(),
      [],
      0
    ) ?? 0;

  const flushNow = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    setSyncing(true);
    try {
      const summary = await flushOutbox();
      setLastSync(summary);
    } finally {
      flushingRef.current = false;
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    setOnline(navigator.onLine);

    const handleOnline = () => {
      setOnline(true);
      void flushNow();
    };
    const handleOffline = () => setOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    void flushNow();
    const interval = window.setInterval(() => {
      if (navigator.onLine) void flushNow();
    }, SYNC_INTERVAL_MS);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.clearInterval(interval);
    };
  }, [flushNow]);

  return { online, pendingOps, conflictOps, syncing, lastSync, flushNow };
}
