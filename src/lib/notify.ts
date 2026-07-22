import "server-only";

/**
 * Escalation notification dispatcher.
 *
 * Ships with a generic webhook transport (Slack/Teams/incident tooling —
 * set NOTIFY_WEBHOOK_URL). Failures are logged, never thrown: notification
 * delivery must not roll back the escalation itself, which is already
 * persisted and audited.
 */

export interface EscalationNotification {
  blockerId: string;
  blockerTitle: string;
  projectCode: string;
  from: string;
  to: string;
  reason: string;
}

async function deliver(text: string, context: string): Promise<void> {
  const webhook = process.env.NOTIFY_WEBHOOK_URL;
  if (!webhook) {
    console.warn(`[notify] NOTIFY_WEBHOOK_URL not set — ${context} recorded in audit log only`);
    return;
  }
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[notify] webhook returned HTTP ${res.status} for ${context}`);
    }
  } catch (err) {
    console.error(`[notify] webhook delivery failed for ${context}`, err);
  }
}

export async function notifyEscalation(n: EscalationNotification): Promise<void> {
  const appUrl = process.env.APP_URL ?? "";
  await deliver(
    `🚨 Blocker escalated: "${n.blockerTitle}" (${n.projectCode})\n` +
      `${n.from} → ${n.to}\n${n.reason}` +
      (appUrl ? `\n${appUrl}` : ""),
    `escalation of blocker ${n.blockerId}`
  );
}

export interface DecisionNotification {
  projectCode: string;
  decisionType: string;
  actionTaken: string;
  decidedBy: string;
}

/** War-room action-item dispatch (Slack/Teams/ITSM intake webhook). */
export async function notifyDecision(n: DecisionNotification): Promise<void> {
  const appUrl = process.env.APP_URL ?? "";
  await deliver(
    `🧭 Steering decision — ${n.projectCode}: ${n.decisionType.replaceAll("_", " ")}\n` +
      `${n.actionTaken}\nSigned off by ${n.decidedBy}` +
      (appUrl ? `\n${appUrl}` : ""),
    `decision on ${n.projectCode}`
  );
}
