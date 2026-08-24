export function previewPageBoundaryFailure(page, {
  path,
  expectedBuildSha,
  expectedClerkKey,
  requireAccountPlans = false,
}) {
  if (!page.includes(`<meta name="solvency-build-sha" content="${expectedBuildSha}">`)) {
    return `${path} does not attest the exact deployed commit.`;
  }
  if (!page.includes(`data-clerk-publishable-key="${expectedClerkKey}"`)
    || page.includes('data-clerk-publishable-key="pk_live_')
    || !page.includes('data-product-intents-enabled="true"')) {
    return `${path} does not expose the exact Preview client boundary.`;
  }
  if (requireAccountPlans && !page.includes('data-account-plans-enabled="true"')) {
    return `${path} does not expose the enabled account-plan client boundary.`;
  }
  return null;
}
