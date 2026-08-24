import { handleEntitlement } from '../../src/lib/server/entitlement-api.ts';
import type { PagesHandler } from '../../src/lib/server/pages-types.ts';

export const onRequest: PagesHandler = handleEntitlement;
