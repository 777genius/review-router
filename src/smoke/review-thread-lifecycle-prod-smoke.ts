export function getReviewRouterSmokeAdminToken(
  env: NodeJS.ProcessEnv = process.env
): string {
  const token = env.REVIEW_ROUTER_SMOKE_ADMIN_TOKEN;
  if (!token) {
    throw new Error('REVIEW_ROUTER_SMOKE_ADMIN_TOKEN is required');
  }
  return token;
}
