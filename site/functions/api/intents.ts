import { handleProductIntent } from '../../src/lib/server/product-intent-api.ts';
import type { PagesHandler } from '../../src/lib/server/pages-types.ts';

export const onRequest: PagesHandler = handleProductIntent;
