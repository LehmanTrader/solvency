export const PRODUCTION_DEPLOYMENT_ORIGIN = 'https://solvency.dev';
export const PREVIEW_DEPLOYMENT_ORIGIN = 'https://d1-functions-preview.solvency-ru5.pages.dev';
export const DEVELOPMENT_DEPLOYMENT_ORIGIN = 'http://localhost:8788';

/**
 * Returns the one public origin allowed to serve security-sensitive callbacks
 * for the configured runtime. Unknown or misspelled environments fail closed.
 */
export function expectedDeploymentOrigin(appEnvironment: unknown): string | null {
  switch (appEnvironment) {
    case 'production':
      return PRODUCTION_DEPLOYMENT_ORIGIN;
    case 'preview':
      return PREVIEW_DEPLOYMENT_ORIGIN;
    case 'development':
      return DEVELOPMENT_DEPLOYMENT_ORIGIN;
    default:
      return null;
  }
}
