import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Audit-log lifecycle management (cron-driven, bearer-secret protected).
 *
 * Rows older than AUDIT_RETENTION_DAYS (default 90) are offloaded in batches
 * to ARCHIVE_WEBHOOK_URL (S3-presigned endpoint, log collector, SIEM intake)
 * and only purged from the hot DB after the archive call succeeds. Without an
 * archive target the endpoint reports eligible rows but purges nothing —
 * unless AUDIT_PURGE_WITHOUT_ARCHIVE=true is set explicitly.
 */

const BATCH = 500;
const MAX_BATCHES_PER_RUN = 20; // bound each cron tick

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function runRetention(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const retentionDays = Number(process.env.AUDIT_RETENTION_DAYS) || 90;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const archiveUrl = process.env.ARCHIVE_WEBHOOK_URL;
  const purgeWithoutArchive = process.env.AUDIT_PURGE_WITHOUT_ARCHIVE === "true";

  const eligible = await prisma.auditLog.count({ where: { createdAt: { lt: cutoff } } });

  if (!archiveUrl && !purgeWithoutArchive) {
    return NextResponse.json({
      eligible,
      archived: 0,
      purged: 0,
      note: "No ARCHIVE_WEBHOOK_URL configured — nothing purged. Set AUDIT_PURGE_WITHOUT_ARCHIVE=true to purge anyway.",
    });
  }

  let archived = 0;
  let purged = 0;

  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const batch = await prisma.auditLog.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      take: BATCH,
    });
    if (batch.length === 0) break;

    if (archiveUrl) {
      try {
        const res = await fetch(archiveUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-ndjson" },
          body: batch.map((row) => JSON.stringify(row)).join("\n"),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          return NextResponse.json(
            { eligible, archived, purged, error: `Archive endpoint returned HTTP ${res.status}` },
            { status: 502 }
          );
        }
        archived += batch.length;
      } catch (err) {
        console.error("[audit-retention] archive delivery failed", err);
        return NextResponse.json(
          { eligible, archived, purged, error: "Archive delivery failed; purge halted" },
          { status: 502 }
        );
      }
    }

    await prisma.auditLog.deleteMany({ where: { id: { in: batch.map((row) => row.id) } } });
    purged += batch.length;
  }

  return NextResponse.json({ eligible, archived, purged, retentionDays });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return runRetention(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return runRetention(req);
}
