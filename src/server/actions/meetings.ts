"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { assertSteeringAuthority, projectReadScope, toActionError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { recordDecisionSchema } from "@/lib/validators";
import { type ActionResult } from "@/server/actions/projects";

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

    const [meeting, project] = await Promise.all([
      prisma.reviewMeeting.findUnique({ where: { id: input.meetingId } }),
      prisma.project.findFirst({ where: { id: input.projectId, ...projectReadScope(user) } }),
    ]);
    if (!meeting) return { ok: false, error: "Meeting not found" };
    if (meeting.closedAt) return { ok: false, error: "Meeting is already closed" };
    if (!project) return { ok: false, error: "Project not found" };

    await prisma.$transaction(async (tx) => {
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
    });

    revalidatePath("/meeting");
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}

/** Close the meeting and return a Markdown minutes summary (decision ledger). */
export async function closeMeetingAction(
  meetingId: string
): Promise<ActionResult<{ meetingId: string; minutesMarkdown: string }>> {
  try {
    const user = await requireSession();
    assertSteeringAuthority(user);

    const meeting = await prisma.reviewMeeting.findUnique({
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
    if (!meeting) return { ok: false, error: "Meeting not found" };
    if (meeting.closedAt) return { ok: false, error: "Meeting is already closed" };

    await prisma.$transaction(async (tx) => {
      await tx.reviewMeeting.update({
        where: { id: meeting.id },
        data: { closedAt: new Date() },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "UPDATE",
          entityType: "ReviewMeeting",
          entityId: meeting.id,
          previous: { closedAt: null },
          next: { closedAt: new Date(), decisionCount: meeting.decisions.length },
        },
        tx
      );
    });

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
