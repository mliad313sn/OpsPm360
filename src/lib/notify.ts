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

// ─── Transactional email (via relay webhook: SES/Graph/Zapier/etc.) ──────────

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** POSTs {to, subject, html, text} to EMAIL_WEBHOOK_URL. Non-throwing. */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const relay = process.env.EMAIL_WEBHOOK_URL;
  if (!relay) {
    console.warn(`[notify] EMAIL_WEBHOOK_URL not set — email "${msg.subject}" not sent`);
    return;
  }
  try {
    const res = await fetch(relay, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`[notify] email relay returned HTTP ${res.status}`);
  } catch (err) {
    console.error("[notify] email relay delivery failed", err);
  }
}

/** Responsive, dark/light-safe action email with a single deep-linked CTA. */
export function buildActionEmail(input: {
  recipientName: string;
  raciRole: "R" | "A" | "C" | "I" | null;
  contextLine: string; // e.g. "Houndé · HND-2026-001 — Pit-to-Plant LTE"
  headline: string;
  detailLines: string[];
  ctaLabel: string;
  ctaUrl: string;
}): { html: string; text: string } {
  const roleLabel =
    input.raciRole === "A"
      ? "Action required — you are Accountable (A)"
      : input.raciRole === "R"
        ? "You are Responsible (R)"
        : input.raciRole === "C"
          ? "Your input is requested (Consulted)"
          : input.raciRole === "I"
            ? "For your information"
            : "Notification";

  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
  <div style="padding:16px 24px;border-bottom:1px solid #e2e8f0;">
    <span style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#4338CA;">OpsPM360 · ${esc(roleLabel)}</span>
    <div style="font-size:12px;color:#475569;margin-top:4px;">${esc(input.contextLine)}</div>
  </div>
  <div style="padding:24px;">
    <h1 style="font-size:18px;margin:0 0 12px;">${esc(input.headline)}</h1>
    <div style="background:#f1f5f9;border-radius:8px;padding:12px 16px;font-size:14px;line-height:1.5;">
      ${input.detailLines.map((l) => `<div>${esc(l)}</div>`).join("")}
    </div>
    <a href="${input.ctaUrl}" style="display:inline-block;margin-top:20px;background:#4338CA;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;">${esc(input.ctaLabel)}</a>
    <p style="font-size:11px;color:#94a3b8;margin-top:20px;">Hello ${esc(input.recipientName)} — this link opens the exact record after sign-in. It routes only; your permissions still apply.</p>
  </div>
</div></body></html>`;

  const text = [
    `OpsPM360 — ${roleLabel}`,
    input.contextLine,
    "",
    input.headline,
    ...input.detailLines,
    "",
    `${input.ctaLabel}: ${input.ctaUrl}`,
  ].join("\n");

  return { html, text };
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
