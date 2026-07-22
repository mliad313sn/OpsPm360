import "server-only";

import { buildDeepLinkUrl, type DeepLinkPayload } from "@/lib/deeplink";
import { buildActionEmail, sendEmail } from "@/lib/notify";
import { withSystemDb } from "@/server/db";

/**
 * RACI-driven dispatch: sends a deep-linked action email to the project's
 * Accountable (A), and informational copies to Informed (I) users.
 * Fire-and-forget — delivery failures never roll back the business change.
 */
export async function notifyProjectRaci(input: {
  projectId: string;
  headline: string;
  detailLines: string[];
  ctaLabel: string;
  deepLink: DeepLinkPayload;
}): Promise<void> {
  const secret = process.env.SESSION_SECRET;
  const appUrl = process.env.APP_URL;
  if (!secret || secret.length < 32 || !appUrl) return;

  try {
    const { project, assignments } = await withSystemDb(async (db) => ({
      project: await db.project.findUnique({
        where: { id: input.projectId },
        select: { code: true, title: true, site: { select: { name: true } } },
      }),
      assignments: await db.raciAssignment.findMany({
        where: { entityType: "PROJECT", entityId: input.projectId, role: { in: ["A", "I"] } },
        include: { user: { select: { name: true, email: true, isActive: true } } },
      }),
    }));
    if (!project) return;

    const url = await buildDeepLinkUrl(input.deepLink, secret, appUrl);
    const contextLine = `${project.site?.name ?? "Group"} · ${project.code} — ${project.title}`;

    for (const a of assignments) {
      if (!a.user.isActive) continue;
      const { html, text } = buildActionEmail({
        recipientName: a.user.name,
        raciRole: a.role as "A" | "I",
        contextLine,
        headline: input.headline,
        detailLines: input.detailLines,
        ctaLabel: input.ctaLabel,
        ctaUrl: url,
      });
      await sendEmail({
        to: a.user.email,
        subject: `[OpsPM360] ${project.code}: ${input.headline}`,
        html,
        text,
      });
    }
  } catch (err) {
    console.error("[raci-notify] dispatch failed", err);
  }
}
