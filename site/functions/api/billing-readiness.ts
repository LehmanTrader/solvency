import { handleBillingReadiness } from '../../src/lib/server/billing-api.ts';
import type { PagesHandler } from '../../src/lib/server/pages-types.ts';

export const onRequest: PagesHandler = handleBillingReadiness;
