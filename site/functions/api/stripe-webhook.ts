import { handleStripeWebhook } from '../../src/lib/server/stripe-webhook.ts';
import type { PagesHandler } from '../../src/lib/server/pages-types.ts';

export const onRequest: PagesHandler = handleStripeWebhook;
