import { handlePreviewAccountErasure } from '../../src/lib/server/account-data-api.ts';
import type { PagesHandler } from '../../src/lib/server/pages-types.ts';

export const onRequest: PagesHandler = handlePreviewAccountErasure;
