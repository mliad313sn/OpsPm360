/**
 * Seed: corporate HQ + 5 gold mine sites, one user per role, and a sample
 * portfolio exercising every RAG state, blocker severity, and currency.
 *
 * Run: npm run db:seed  (requires DATABASE_URL)
 * Default password for all seeded users: "Endeavour#2026" — CHANGE IN PROD.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64);
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

const DAY = 86_400_000;
const now = Date.now();

async function main(): Promise<void> {
  const password = hashPassword("Endeavour#2026");

  const hq = await prisma.site.upsert({
    where: { code: "HQ" },
    update: {},
    create: {
      name: "Corporate HQ (London/Abidjan)",
      code: "HQ",
      country: "United Kingdom / Côte d'Ivoire",
      timezone: "Europe/London",
      isHq: true,
    },
  });

  const siteDefs = [
    { name: "Sabodala-Massawa", code: "SBD", country: "Senegal", timezone: "Africa/Dakar" },
    { name: "Ity", code: "ITY", country: "Côte d'Ivoire", timezone: "Africa/Abidjan" },
    { name: "Houndé", code: "HND", country: "Burkina Faso", timezone: "Africa/Ouagadougou" },
    { name: "Mana", code: "MNA", country: "Burkina Faso", timezone: "Africa/Ouagadougou" },
    { name: "Boungou", code: "BGU", country: "Burkina Faso", timezone: "Africa/Ouagadougou" },
  ];

  const sites: Record<string, string> = {};
  for (const def of siteDefs) {
    const site = await prisma.site.upsert({
      where: { code: def.code },
      update: {},
      create: { ...def, wanStatus: def.code === "BGU" ? "DEGRADED" : "ONLINE" },
    });
    sites[def.code] = site.id;
  }

  const admin = await prisma.user.upsert({
    where: { email: "admin@endeavourmining.com" },
    update: {},
    create: {
      email: "admin@endeavourmining.com",
      name: "System Administrator",
      role: "SYSTEM_ADMIN",
      passwordHash: password,
    },
  });

  const groupManager = await prisma.user.upsert({
    where: { email: "amara.kone@endeavourmining.com" },
    update: {},
    create: {
      email: "amara.kone@endeavourmining.com",
      name: "Amara Koné",
      role: "GROUP_IT_MANAGER",
      passwordHash: password,
    },
  });

  await prisma.user.upsert({
    where: { email: "cio@endeavourmining.com" },
    update: {},
    create: {
      email: "cio@endeavourmining.com",
      name: "Group CIO",
      role: "EXEC_STAKEHOLDER",
      passwordHash: password,
    },
  });

  const siteLeadDefs = [
    { email: "lead.sbd@endeavourmining.com", name: "Fatou Ndiaye", site: "SBD" },
    { email: "lead.ity@endeavourmining.com", name: "Yao Kouassi", site: "ITY" },
    { email: "lead.hnd@endeavourmining.com", name: "Boureima Ouédraogo", site: "HND" },
    { email: "lead.mna@endeavourmining.com", name: "Awa Sawadogo", site: "MNA" },
    { email: "lead.bgu@endeavourmining.com", name: "Issa Zongo", site: "BGU" },
  ];

  const leads: Record<string, string> = {};
  for (const def of siteLeadDefs) {
    const user = await prisma.user.upsert({
      where: { email: def.email },
      update: {},
      create: {
        email: def.email,
        name: def.name,
        role: "SITE_IT_LEAD",
        siteId: sites[def.site],
        passwordHash: password,
      },
    });
    leads[def.site] = user.id;
  }

  // ── Sample portfolio ───────────────────────────────────────────────────────
  const existing = await prisma.project.count();
  if (existing > 0) {
    console.log("Projects already seeded; skipping portfolio seed.");
    return;
  }

  // 1. Group project, healthy (GREEN)
  await prisma.project.create({
    data: {
      code: "GRP-2026-001",
      title: "Group ERP S/4HANA Migration — Wave 2",
      description:
        "Migrate remaining site finance ledgers to the group S/4HANA instance with WAN-optimized replication.",
      scopeType: "GROUP",
      ownerId: groupManager.id,
      status: "IN_PROGRESS",
      currentGate: "EXECUTION",
      startDate: new Date(now - 90 * DAY),
      targetEndDate: new Date(now + 120 * DAY),
      financials: {
        create: {
          capexBudgetUSD: 2_400_000,
          opexBudgetUSD: 350_000,
          capexActualUSD: 1_100_000,
          opexActualUSD: 140_000,
          localCurrency: "USD",
          fxRateToBase: 1,
          sapWBSElement: "C.4410.02",
        },
      },
      milestones: {
        create: [
          {
            title: "Data migration dry run",
            targetDate: new Date(now - 30 * DAY),
            actualDate: new Date(now - 32 * DAY),
            status: "COMPLETED",
            weightPercent: 40,
          },
          { title: "Cutover rehearsal", targetDate: new Date(now + 30 * DAY), weightPercent: 30 },
          { title: "Go-live", targetDate: new Date(now + 100 * DAY), weightPercent: 30 },
        ],
      },
    },
  });

  // 2. Houndé site project with an aged CRITICAL blocker (forces RED)
  const hndProject = await prisma.project.create({
    data: {
      code: "HND-2026-001",
      title: "Houndé Pit-to-Plant LTE Network",
      description: "Private LTE for autonomous haulage telemetry across the Houndé pit.",
      scopeType: "SITE",
      siteId: sites.HND ?? null,
      ownerId: leads.HND ?? groupManager.id,
      status: "IN_PROGRESS",
      currentGate: "EXECUTION",
      startDate: new Date(now - 60 * DAY),
      targetEndDate: new Date(now + 60 * DAY),
      financials: {
        create: {
          capexBudgetUSD: 850_000,
          opexBudgetUSD: 90_000,
          capexActualUSD: 700_000,
          opexActualUSD: 85_000,
          localCurrency: "XOF",
          fxRateToBase: 605.5,
          sapWBSElement: "C.5120.07",
        },
      },
      milestones: {
        create: [
          {
            title: "Tower survey",
            targetDate: new Date(now - 20 * DAY),
            actualDate: new Date(now - 18 * DAY),
            status: "COMPLETED",
            weightPercent: 30,
          },
          {
            title: "Core network install",
            targetDate: new Date(now - 10 * DAY),
            status: "DELAYED",
            weightPercent: 40,
          },
          { title: "Site acceptance test", targetDate: new Date(now + 45 * DAY), weightPercent: 30 },
        ],
      },
    },
  });

  await prisma.blocker.create({
    data: {
      projectId: hndProject.id,
      raisedById: leads.HND ?? groupManager.id,
      title: "Customs clearance stuck for LTE core hardware",
      description: "Core network racks held at Ouagadougou customs for 12 days; import permit query.",
      severity: "CRITICAL",
      status: "ESCALATED",
      escalationLevel: "GROUP_IT_MANAGER",
      createdAt: new Date(now - 12 * DAY),
      lastEscalatedAt: new Date(now - 9 * DAY),
    },
  });

  // 3. Sabodala project over budget (AMBER/RED variance), EUR local
  await prisma.project.create({
    data: {
      code: "SBD-2026-001",
      title: "Sabodala-Massawa Process Control Upgrade",
      description: "Replace obsolete PLC fleet in the CIL plant and integrate with historian.",
      scopeType: "SITE",
      siteId: sites.SBD ?? null,
      ownerId: leads.SBD ?? groupManager.id,
      status: "IN_PROGRESS",
      currentGate: "EXECUTION",
      startDate: new Date(now - 150 * DAY),
      targetEndDate: new Date(now + 30 * DAY),
      financials: {
        create: {
          capexBudgetUSD: 1_200_000,
          opexBudgetUSD: 100_000,
          capexActualUSD: 1_450_000,
          opexActualUSD: 95_000,
          localCurrency: "EUR",
          fxRateToBase: 0.92,
          sapWBSElement: "C.3310.11",
        },
      },
      milestones: {
        create: [
          {
            title: "PLC hardware delivered",
            targetDate: new Date(now - 60 * DAY),
            actualDate: new Date(now - 55 * DAY),
            status: "COMPLETED",
            weightPercent: 50,
          },
          { title: "Hot cutover", targetDate: new Date(now + 20 * DAY), weightPercent: 50 },
        ],
      },
      scopeChanges: {
        create: {
          requestedById: leads.SBD ?? groupManager.id,
          scopeDeltaDescription:
            "Extend upgrade to Massawa crusher line PLCs discovered to be end-of-life during survey.",
          budgetImpactUSD: 240_000,
          timeImpactDays: 35,
        },
      },
    },
  });

  // 4. Ity project, proposed stage (GREEN)
  await prisma.project.create({
    data: {
      code: "ITY-2026-001",
      title: "Ity Camp Wi-Fi 6 Refresh",
      description: "Refresh accommodation-camp wireless with Wi-Fi 6 and captive portal.",
      scopeType: "SITE",
      siteId: sites.ITY ?? null,
      ownerId: leads.ITY ?? groupManager.id,
      status: "IN_REVIEW",
      currentGate: "ARCH_REVIEW",
      startDate: new Date(now + 15 * DAY),
      targetEndDate: new Date(now + 120 * DAY),
      financials: {
        create: {
          capexBudgetUSD: 180_000,
          opexBudgetUSD: 25_000,
          localCurrency: "XOF",
          fxRateToBase: 605.5,
        },
      },
      milestones: {
        create: [
          { title: "RF survey", targetDate: new Date(now + 30 * DAY), weightPercent: 30 },
          { title: "AP rollout", targetDate: new Date(now + 90 * DAY), weightPercent: 70 },
        ],
      },
    },
  });

  console.log("Seed complete. Login: amara.kone@endeavourmining.com / Endeavour#2026");
  console.log(`HQ site: ${hq.name}`);
  console.log(`Admin: ${admin.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
