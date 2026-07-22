import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { fetchPortfolio, fetchWarRoomSignals } from "@/server/queries";
import { prisma } from "@/lib/prisma";
import { withUserDb } from "@/server/db";
import { AppShell } from "@/components/app-shell";
import { WarRoom, type MeetingSession } from "@/components/war-room/war-room";

export const dynamic = "force-dynamic";

export default async function MeetingPage(): Promise<JSX.Element> {
  const user = await getSession();
  if (!user) redirect("/login");

  const [portfolio, signals, siteName, openMeeting] = await Promise.all([
    fetchPortfolio(user),
    fetchWarRoomSignals(user),
    user.siteId
      ? prisma.site
          .findUnique({ where: { id: user.siteId }, select: { name: true } })
          .then((s) => s?.name ?? null)
      : Promise.resolve(null),
    withUserDb(user, (db) =>
      db.reviewMeeting.findFirst({
        where: { closedAt: null },
        orderBy: { meetingDate: "desc" },
        include: {
          chairedBy: { select: { name: true } },
          decisions: {
            include: {
              project: { select: { code: true } },
              signedOffBy: { select: { name: true } },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      })
    ),
  ]);

  const session: MeetingSession | null = openMeeting
    ? {
        id: openMeeting.id,
        chairName: openMeeting.chairedBy.name,
        startedAt: openMeeting.meetingDate.toISOString(),
        decisions: openMeeting.decisions.map((d) => ({
          id: d.id,
          decisionType: d.decisionType,
          actionTaken: d.actionTaken,
          projectCode: d.project.code,
          by: d.signedOffBy.name,
          at: d.createdAt.toISOString(),
        })),
      }
    : null;

  const canSteer = user.role === "GROUP_IT_MANAGER" || user.role === "SYSTEM_ADMIN";

  return (
    <AppShell user={{ name: user.name, role: user.role, siteName }}>
      <WarRoom rows={portfolio} canSteer={canSteer} session={session} signals={signals} />
    </AppShell>
  );
}
