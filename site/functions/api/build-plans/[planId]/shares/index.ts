import { handleBuildPlanShareCollection } from '../../../../../src/lib/server/build-plan-operations-api.ts';
import type { PagesHandler } from '../../../../../src/lib/server/pages-types.ts';

export const onRequest: PagesHandler = handleBuildPlanShareCollection;
