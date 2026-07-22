import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { fetchPortfolio, fetchWarRoomSignals } from "@/server/queries";
import { prisma } from "@/lib/prisma";
import { PresentationMode } from "@/components/review/presentation-mode";

export const dynamic = "force-dynamic";

/** Site-by-site Executive Review: full-screen, keyboard-driven walkthrough. */
export default async function ReviewPage(): Promise<JSX.Element> {
  const user = await getSession();
  if (!user) redirect("/login");

  const [portfolio, signals, openMeeting] = await Promise.all([
    fetchPortfolio(user),
    fetchWarRoomSignals(user),
    prisma.reviewMeeting.findFirst({
      where: { closedAt: null },
      orderBy: { meetingDate: "desc" },
      select: { id: true },
    }),
  ]);

  const canSteer = user.role === "GROUP_IT_MANAGER" || user.role === "SYSTEM_ADMIN";

  return (
    <PresentationMode
      rows={portfolio}
      signals={signals}
      meetingId={openMeeting?.id ?? null}
      canSteer={canSteer}
    />
  );
}
