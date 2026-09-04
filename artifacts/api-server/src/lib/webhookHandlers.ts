import { getStripeSync } from "./stripeClient.js";
import { applyReferralConversion } from "./referralCredit.js";
import { logger } from "./logger.js";

/**
 * Minimal Stripe webhook handler. Delegates entirely to stripe-replit-sync,
 * which validates the signature and syncs the event into the `stripe` schema.
 * After sync, hooks custom business logic:
 *   - checkout.session.completed: apply referral conversion credit to the
 *     referrer if the buyer arrived via a referral link.
 */
export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
          "Received type: " +
          typeof payload +
          ". This usually means express.json() parsed the body before reaching " +
          "this handler. FIX: Ensure webhook route is registered BEFORE " +
          "app.use(express.json()).",
      );
    }

    const sync = await getStripeSync();
    // stripe-replit-sync validates the signature and throws on mismatch.
    await sync.processWebhook(payload, signature);

    // Post-sync hook: parse the verified event and apply custom business logic.
    // It's safe to parse the raw payload here because signature validation
    // already succeeded above.
    try {
      const event = JSON.parse(payload.toString("utf8")) as {
        type?: string;
        data?: { object?: Record<string, unknown> };
      };

      if (event?.type === "checkout.session.completed") {
        const session = event.data?.object as {
          customer_email?: string;
          payment_status?: string;
        } | undefined;
        if (session?.payment_status === "paid" && session.customer_email) {
          // Best-effort: attribute referral conversion credit. Idempotent via
          // the partial unique index — /billing/confirm and reconciliation are
          // safe fallbacks; this is the preferred event-driven trigger.
          void applyReferralConversion(session.customer_email, logger);
        }
      }
    } catch (err) {
      // Never let custom hook errors propagate and make Stripe retry the webhook.
      logger.warn({ err }, "Webhook post-sync hook failed (non-fatal)");
    }
  }
}
