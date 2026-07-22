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

export async function notifyEscalation(n: EscalationNotification): Promise<void> {
  const webhook = process.env.NOTIFY_WEBHOOK_URL;
  const appUrl = process.env.APP_URL ?? "";

  if (!webhook) {
    console.warn(
      `[notify] NOTIFY_WEBHOOK_URL not set — escalation of blocker ${n.blockerId} (${n.from} → ${n.to}) recorded in audit log only`
    );
    return;
  }

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text:
          `🚨 Blocker escalated: "${n.blockerTitle}" (${n.projectCode})\n` +
          `${n.from} → ${n.to}\n${n.reason}` +
          (appUrl ? `\n${appUrl}` : ""),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[notify] webhook returned HTTP ${res.status} for blocker ${n.blockerId}`);
    }
  } catch (err) {
    console.error(`[notify] webhook delivery failed for blocker ${n.blockerId}`, err);
  }
}
