"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { assertSteeringAuthority, projectReadScope, toActionError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { recordDecisionSchema } from "@/lib/validators";
import { type ActionResult } from "@/server/actions/projects";
import { withUserDb } from "@/server/db";
import { notifyDecision } from "@/lib/notify";

export async function startMeetingAction(): Promise<ActionResult<{ meetingId: string }>> {
  try {
    const user = await requireSession();
    assertSteeringAuthority(user);

    // Reuse an open meeting from today if one exists (idempotent "start").
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const existing = await prisma.reviewMeeting.findFirst({
      where: { chairedById: user.id, closedAt: null, meetingDate: { gte: startOfDay } },
    });
    if (existing) return { ok: true, data: { meetingId: existing.id } };

    const meeting = await prisma.$transaction(async (tx) => {
      const created = await tx.reviewMeeting.create({
        data: { meetingDate: new Date(), chairedById: user.id },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "CREATE",
          entityType: "ReviewMeeting",
          entityId: created.id,
          next: { meetingDate: created.meetingDate },
        },
        tx
      );
      return created;
    });

    revalidatePath("/meeting");
    return { ok: true, data: { meetingId: meeting.id } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function recordDecisionAction(raw: unknown): Promise<ActionResult> {
  try {
    const user = await requireSession();
    assertSteeringAuthority(user);
    const input = recordDecisionSchema.parse(raw);

    const outcome = await withUserDb(user, async (tx) => {
      const meeting = await tx.reviewMeeting.findUnique({ where: { id: input.meetingId } });
      if (!meeting) return { error: "Meeting not found" };
      if (meeting.closedAt) return { error: "Meeting is already closed" };
      const project = await tx.project.findFirst({
        where: { id: input.projectId, ...projectReadScope(user) },
      });
      if (!project) return { error: "Project not found" };

      const decision = await tx.meetingDecision.create({
        data: {
          meetingId: meeting.id,
          projectId: project.id,
          decisionType: input.decisionType,
          actionTaken: input.actionTaken,
          signedOffById: user.id,
        },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "CREATE",
          entityType: "MeetingDecision",
          entityId: decision.id,
          next: {
            meetingId: meeting.id,
            projectId: project.id,
            decisionType: input.decisionType,
            actionTaken: input.actionTaken,
          },
        },
        tx
      );
      return { projectCode: project.code };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    // Action-item dispatch: decisions don't die in the minutes (webhook →
    // Slack/Teams/ITSM intake). Fire-and-forget; delivery never blocks the record.
    if (input.decisionType !== "NOTE") {
      await notifyDecision({
        projectCode: outcome.projectCode,
        decisionType: input.decisionType,
        actionTaken: input.actionTaken,
        decidedBy: user.name,
      });
    }

    revalidatePath("/meeting");
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}

/** Close the meeting and return a Markdown minutes summary (decision ledger). */
export async function closeMeetingAction(
  rawMeetingId: string
): Promise<ActionResult<{ meetingId: string; minutesMarkdown: string }>> {
  try {
    const user = await requireSession();
    assertSteeringAuthority(user);
    const meetingId = z.string().cuid().parse(rawMeetingId);

    const meeting = await withUserDb(user, async (tx) => {
      const found = await tx.reviewMeeting.findUnique({
        where: { id: meetingId },
        include: {
          chairedBy: { select: { name: true } },
          decisions: {
            include: {
              project: { select: { code: true, title: true } },
              signedOffBy: { select: { name: true } },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!found || found.closedAt) return found;

      await tx.reviewMeeting.update({
        where: { id: found.id },
        data: { closedAt: new Date() },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "UPDATE",
          entityType: "ReviewMeeting",
          entityId: found.id,
          previous: { closedAt: null },
          next: { closedAt: new Date(), decisionCount: found.decisions.length },
        },
        tx
      );
      return found;
    });

    if (!meeting) return { ok: false, error: "Meeting not found" };
    if (meeting.closedAt) return { ok: false, error: "Meeting is already closed" };

    const lines: string[] = [
      `# Steering Committee Minutes`,
      ``,
      `**Date:** ${meeting.meetingDate.toISOString().slice(0, 10)}`,
      `**Chair:** ${meeting.chairedBy.name}`,
      `**Decisions:** ${meeting.decisions.length}`,
      ``,
      `| # | Project | Decision | Action | Signed off by |`,
      `|---|---------|----------|--------|---------------|`,
      ...meeting.decisions.map(
        (d, i) =>
          `| ${i + 1} | ${d.project.code} — ${d.project.title} | ${d.decisionType} | ${d.actionTaken.replaceAll("|", "\\|")} | ${d.signedOffBy.name} |`
      ),
    ];

    revalidatePath("/meeting");
    return { ok: true, data: { meetingId: meeting.id, minutesMarkdown: lines.join("\n") } };
  } catch (err) {
    return toActionError(err);
  }
}
