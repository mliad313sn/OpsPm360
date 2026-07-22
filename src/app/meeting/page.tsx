import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { fetchPortfolio } from "@/server/queries";
import { prisma } from "@/lib/prisma";
import { AppShell } from "@/components/app-shell";
import { WarRoom } from "@/components/war-room/war-room";

export const dynamic = "force-dynamic";

export default async function MeetingPage(): Promise<JSX.Element> {
  const user = await getSession();
  if (!user) redirect("/login");

  const [portfolio, siteName] = await Promise.all([
    fetchPortfolio(user),
    user.siteId
      ? prisma.site
          .findUnique({ where: { id: user.siteId }, select: { name: true } })
          .then((s) => s?.name ?? null)
      : Promise.resolve(null),
  ]);

  const canSteer = user.role === "GROUP_IT_MANAGER" || user.role === "SYSTEM_ADMIN";

  return (
    <AppShell user={{ name: user.name, role: user.role, siteName }}>
      <WarRoom rows={portfolio} canSteer={canSteer} />
    </AppShell>
  );
}
