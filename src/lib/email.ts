import { Resend } from "resend";

/**
 * Email sending.
 *
 * Degrades to a logged no-op when RESEND_API_KEY is absent so local runs and
 * tests do not explode, and returns what it would have sent so a caller can
 * report honestly rather than claiming success.
 *
 * Worth knowing: Resend only sends from a verified domain.
 * `onboarding@resend.dev` works for testing but delivers only to your own
 * address - a confusing failure mode if you do not know it going in.
 */

export type Message = { to: string; subject: string; text: string };
export type SendResult = { sent: number; skipped: number; errors: string[] };

function sender(): string {
  return process.env.EMAIL_FROM ?? "Secret Santa Shirts <onboarding@resend.dev>";
}

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendAll(messages: Message[]): Promise<SendResult> {
  if (messages.length === 0) return { sent: 0, skipped: 0, errors: [] };

  if (!emailConfigured()) {
    console.warn(
      `[email] RESEND_API_KEY is not set - ${messages.length} message(s) not sent:`,
      messages.map((m) => `${m.to}: ${m.subject}`).join("; "),
    );
    return { sent: 0, skipped: messages.length, errors: [] };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const result: SendResult = { sent: 0, skipped: 0, errors: [] };

  for (const message of messages) {
    try {
      // Sequential rather than parallel: a dozen emails once a day does not
      // need concurrency, and a partial failure is easier to report this way.
      const response = await resend.emails.send({
        from: sender(),
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      if (response.error) result.errors.push(`${message.to}: ${response.error.message}`);
      else result.sent += 1;
    } catch (error) {
      result.errors.push(
        `${message.to}: ${error instanceof Error ? error.message : "send failed"}`,
      );
    }
  }

  return result;
}
