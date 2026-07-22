import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isGroupScoped } from "@/lib/rbac";
import { AppShell } from "@/components/app-shell";
import { ProjectWizard } from "@/components/projects/project-wizard";

export const dynamic = "force-dynamic";

export default async function NewProjectPage(): Promise<JSX.Element> {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role === "EXEC_STAKEHOLDER") redirect("/");

  const sites = await prisma.site.findMany({
    where: isGroupScoped(user) ? { isHq: false } : { id: user.siteId ?? "__none__" },
    select: { id: true, name: true, code: true, country: true },
    orderBy: { name: "asc" },
  });

  const siteName = user.siteId
    ? (sites.find((s) => s.id === user.siteId)?.name ?? null)
    : null;

  return (
    <AppShell user={{ name: user.name, role: user.role, siteName }}>
      <ProjectWizard
        sites={sites}
        canCreateGroupScope={isGroupScoped(user)}
        defaultSiteId={user.siteId}
      />
    </AppShell>
  );
}
