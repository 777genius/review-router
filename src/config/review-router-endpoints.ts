/** Canonical ReviewRouter public endpoints. The literals live in
 * review-router-endpoints.json (YAML/bash and Node scripts read that file
 * directly because this package is CommonJS); this module is the typed API for
 * the codebase. A domain migration changes the JSON and then runs
 * `npm run domains:sync` to rewrite the workflow and shell literals. Generated
 * JSON Schema `$id` namespaces are stable identifiers and intentionally do not
 * follow these origins. */
import endpoints from './review-router-endpoints.json';

export const REVIEW_ROUTER_WEB_ORIGIN = endpoints.webOrigin;
export const REVIEW_ROUTER_API_ORIGIN = endpoints.apiOrigin;

export const CODEX_SEED_SCRIPT_URL = `${REVIEW_ROUTER_WEB_ORIGIN}/install/codex`;
export const NEWTEST_V4_ROOT_URL = `${REVIEW_ROUTER_API_ORIGIN}/__newtest_v4/`;
