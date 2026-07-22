import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";
import { isGroupScoped } from "@/lib/rbac";

/**
 * Database-level tenant isolation (Postgres RLS).
 *
 * Every query touching the project tree (Project, Milestone, Blocker, Risk,
 * ProjectFinancials, ScopeChangeRequest, MeetingDecision) MUST run inside one
 * of these wrappers. They open a transaction and set transaction-local GUCs
 * (`app.scope`, `app.site_id`) that the RLS policies evaluate. A query that
 * skips the wrapper sees ZERO rows — tenant leaks fail closed.
 *
 * Application-level `projectReadScope()` fragments remain as a second,
 * defense-in-depth layer; RLS is the floor, not a replacement for asserts.
 */

export type Db = Prisma.TransactionClient;

async function setContext(tx: Db, scope: "system" | "group" | "site", siteId: string) {
  await tx.$executeRaw`SELECT set_config('app.scope', ${scope}, true), set_config('app.site_id', ${siteId}, true)`;
}

/** Run `fn` with the caller's tenant context enforced by the database. */
export function withUserDb<T>(user: SessionUser, fn: (db: Db) => Promise<T>): Promise<T> {
  const scope = isGroupScoped(user) ? "group" : "site";
  return prisma.$transaction(async (tx) => {
    await setContext(tx, scope, user.siteId ?? "");
    return fn(tx);
  });
}

/** Trusted server routines only (SLA sweep, RAG recalc, seed): full visibility. */
export function withSystemDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await setContext(tx, "system", "");
    return fn(tx);
  });
}
