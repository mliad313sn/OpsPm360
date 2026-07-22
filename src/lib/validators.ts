import { z } from "zod";

/**
 * Shared Zod contracts. Every payload crossing a trust boundary (client →
 * server action, offline sync queue → /api/sync) is validated with these.
 */

export const ragSchema = z.enum(["RED", "AMBER", "GREEN"]);
export const scopeTypeSchema = z.enum(["GROUP", "SITE"]);
export const projectStatusSchema = z.enum([
  "PROPOSED",
  "IN_REVIEW",
  "APPROVED",
  "IN_PROGRESS",
  "PAUSED",
  "COMPLETED",
]);
export const stageGateSchema = z.enum([
  "INTEL_GATHERING",
  "ARCH_REVIEW",
  "EXECUTION",
  "HANDOVER",
  "CLOSED",
]);
export const blockerSeveritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
export const localCurrencySchema = z.enum(["USD", "EUR", "XOF"]);
export const decisionTypeSchema = z.enum([
  "UNBLOCK",
  "SCOPE_APPROVED",
  "SCOPE_REJECTED",
  "RAG_OVERRIDE",
  "PAUSE",
  "RESUME",
  "ESCALATE_TO_CIO",
]);

const isoDate = z.coerce.date();
const money = z.number().finite().min(0).max(1_000_000_000);

export const cobitChecklistSchema = z.object({
  edm01_governanceFramework: z.boolean(),
  apo12_riskAssessed: z.boolean(),
  apo13_securityReviewed: z.boolean(),
  bai01_benefitsDefined: z.boolean(),
  dss04_continuityConsidered: z.boolean(),
  notes: z.string().max(2000).optional(),
});
export type CobitChecklist = z.infer<typeof cobitChecklistSchema>;

export const createProjectSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(1).max(5000),
    scopeType: scopeTypeSchema,
    siteId: z.string().cuid().nullable(),
    startDate: isoDate,
    targetEndDate: isoDate,
    cobitChecklist: cobitChecklistSchema,
    financials: z.object({
      capexBudgetUSD: money,
      opexBudgetUSD: money,
      localCurrency: localCurrencySchema,
      fxRateToBase: z.number().finite().positive().max(1_000_000),
      sapWBSElement: z.string().trim().max(50).optional(),
    }),
    milestones: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(200),
          targetDate: isoDate,
          weightPercent: z.number().int().min(0).max(100),
        })
      )
      .max(50)
      .superRefine((ms, ctx) => {
        if (ms.length === 0) return;
        const total = ms.reduce((acc, m) => acc + m.weightPercent, 0);
        if (total !== 100) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Milestone weights must sum to 100 (got ${total})`,
          });
        }
      }),
  })
  .superRefine((val, ctx) => {
    if (val.targetEndDate <= val.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetEndDate"],
        message: "Target end date must be after start date",
      });
    }
    if (val.scopeType === "SITE" && !val.siteId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["siteId"],
        message: "SITE-scope projects require a site",
      });
    }
  });
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  projectId: z.string().cuid(),
  expectedSyncVersion: z.number().int().positive(),
  patch: z
    .object({
      title: z.string().trim().min(3).max(200).optional(),
      description: z.string().trim().min(1).max(5000).optional(),
      status: projectStatusSchema.optional(),
      currentGate: stageGateSchema.optional(),
      startDate: isoDate.optional(),
      targetEndDate: isoDate.optional(),
      actualEndDate: isoDate.nullable().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, { message: "Empty patch" }),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const ragOverrideSchema = z.object({
  projectId: z.string().cuid(),
  override: ragSchema.nullable(), // null clears the override
  reason: z.string().trim().min(10, "Override reason must be at least 10 characters").max(1000),
});
export type RagOverrideInput = z.infer<typeof ragOverrideSchema>;

export const createBlockerSchema = z.object({
  projectId: z.string().cuid(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(1).max(5000),
  severity: blockerSeveritySchema,
  targetResolutionDate: isoDate.nullable().optional(),
});
export type CreateBlockerInput = z.infer<typeof createBlockerSchema>;

export const resolveBlockerSchema = z.object({
  blockerId: z.string().cuid(),
  resolutionNotes: z.string().trim().min(5).max(5000),
});
export type ResolveBlockerInput = z.infer<typeof resolveBlockerSchema>;

export const createScopeChangeSchema = z.object({
  projectId: z.string().cuid(),
  scopeDeltaDescription: z.string().trim().min(10).max(5000),
  budgetImpactUSD: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
  timeImpactDays: z.number().int().min(-3650).max(3650),
});
export type CreateScopeChangeInput = z.infer<typeof createScopeChangeSchema>;

export const decideScopeChangeSchema = z.object({
  requestId: z.string().cuid(),
  approve: z.boolean(),
  decisionNotes: z.string().trim().max(2000).optional(),
});
export type DecideScopeChangeInput = z.infer<typeof decideScopeChangeSchema>;

export const recordDecisionSchema = z.object({
  meetingId: z.string().cuid(),
  projectId: z.string().cuid(),
  decisionType: decisionTypeSchema,
  actionTaken: z.string().trim().min(3).max(2000),
});
export type RecordDecisionInput = z.infer<typeof recordDecisionSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ─── Offline delta-sync envelope ─────────────────────────────────────────────

export const syncOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("project.update"),
    clientOpId: z.string().uuid(),
    occurredAt: isoDate,
    data: updateProjectSchema,
  }),
  z.object({
    kind: z.literal("blocker.create"),
    clientOpId: z.string().uuid(),
    occurredAt: isoDate,
    data: createBlockerSchema,
  }),
  z.object({
    kind: z.literal("blocker.resolve"),
    clientOpId: z.string().uuid(),
    occurredAt: isoDate,
    data: resolveBlockerSchema,
  }),
]);
export type SyncOperation = z.infer<typeof syncOperationSchema>;

export const syncBatchSchema = z.object({
  operations: z.array(syncOperationSchema).min(1).max(100),
});
export type SyncBatch = z.infer<typeof syncBatchSchema>;

export interface SyncOpResult {
  clientOpId: string;
  status: "applied" | "duplicate" | "conflict" | "rejected";
  message?: string;
  /** For conflicts: authoritative server state so the client can rebase. */
  serverState?: unknown;
}
