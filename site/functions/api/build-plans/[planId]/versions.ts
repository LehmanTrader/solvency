import { handleBuildPlanVersions } from '../../../../src/lib/server/build-plan-api.ts';
import type { PagesHandler } from '../../../../src/lib/server/pages-types.ts';

export const onRequest: PagesHandler = handleBuildPlanVersions;
