/** Rewrites ReviewRouter domain literals in workflow and shell files to the
 * canonical origins in src/config/review-router-endpoints.json and audits the
 * managed files for foreign URLs. YAML and bash cannot import shared modules,
 * so those files carry literals and this script is their sync tool. Plain
 * CommonJS-free ESM on purpose so `node script.mjs` works on every supported
 * engine (the package engines allow Node 20, which cannot execute .mts).
 * Usage: node scripts/sync-review-router-domains.mjs [--check].
 *
 * - Workflow files: values of the managed `default`, `api_url` and
 *   `control_plane_url` keys that look like URLs are set to the canonical API
 *   origin, whatever they currently point at.
 * - Shell files: reviewrouter.* family URLs are rewritten to the canonical
 *   origins; a future domain outside that family needs its pattern added here.
 * - Audit: every URL in the managed files must sit on a canonical origin or a
 *   listed infrastructure host; anything else (for example a stale or
 *   misspelled origin) fails both modes and needs a manual fix.
 *
 * Generated JSON Schema `$id` namespaces never follow these origins and are
 * outside the target list on purpose. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const repoRoot = process.env.REVIEW_ROUTER_DOMAINS_ROOT
  ? path.resolve(process.env.REVIEW_ROUTER_DOMAINS_ROOT)
  : scriptRoot;

const endpoints = JSON.parse(
  fs.readFileSync(
    path.join(scriptRoot, 'src/config/review-router-endpoints.json'),
    'utf8'
  )
);
const REVIEW_ROUTER_WEB_ORIGIN = endpoints.webOrigin;
const REVIEW_ROUTER_API_ORIGIN = endpoints.apiOrigin;

const WORKFLOW_FILES = [
  '.github/workflows/reviewrouter-reusable.yml',
  '.github/workflows/reviewrouter-interaction-reusable.yml',
  '.github/workflows/reviewrouter-t0-reusable.yml',
  '.github/workflows/reviewrouter-runtime.yml',
  '.github/workflows/reviewrouter.yml',
];
const SHELL_FILES = [
  'scripts/seed-codex-auth.sh',
  'scripts/reseed-codex-rotating-auth.sh',
];
const TARGET_FILES = [...WORKFLOW_FILES, ...SHELL_FILES];

const MANAGED_YAML_KEY_URL =
  /^(\s*(?:default|api_url|control_plane_url):\s*)(https?:\S+)\s*$/;
const API_ORIGIN_PATTERN =
  /https:\/\/api\.reviewrouter\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g;
const WEB_ORIGIN_PATTERN =
  /https:\/\/reviewrouter\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g;
const URL_PATTERN = /https?:\/\/[^\s"'`>)\]}]+/g;
const INFRASTRUCTURE_HOSTS = new Set(['github.com']);
const CANONICAL_ORIGINS = new Set(
  [REVIEW_ROUTER_WEB_ORIGIN, REVIEW_ROUTER_API_ORIGIN].map(
    (origin) => new URL(origin).origin
  )
);

function syncContent(file, content) {
  if (WORKFLOW_FILES.includes(file)) {
    return content
      .split('\n')
      .map((line) => {
        const match = line.match(MANAGED_YAML_KEY_URL);
        return match ? `${match[1]}${REVIEW_ROUTER_API_ORIGIN}` : line;
      })
      .join('\n');
  }
  return content
    .replace(API_ORIGIN_PATTERN, REVIEW_ROUTER_API_ORIGIN)
    .replace(WEB_ORIGIN_PATTERN, REVIEW_ROUTER_WEB_ORIGIN);
}

function auditContent(content) {
  const offenders = [];
  for (const url of content.match(URL_PATTERN) ?? []) {
    const parsed = new URL(url);
    if (CANONICAL_ORIGINS.has(parsed.origin)) continue;
    if (INFRASTRUCTURE_HOSTS.has(parsed.host)) continue;
    offenders.push(url);
  }
  return offenders;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const problems = [];
  for (const file of TARGET_FILES) {
    const absolute = path.join(repoRoot, file);
    const current = fs.readFileSync(absolute, 'utf8');
    const updated = syncContent(file, current);
    if (updated !== current) {
      problems.push(
        checkOnly
          ? `stale domain literals: ${file}`
          : `domain literals synced: ${file}`
      );
      if (!checkOnly) fs.writeFileSync(absolute, updated);
    }
    for (const url of auditContent(updated))
      problems.push(`foreign URL in ${file}: ${url}`);
  }
  if (problems.length === 0) return;
  for (const line of problems) console.log(line);
  const foreign = problems.some((line) => line.startsWith('foreign URL'));
  if (checkOnly || foreign) {
    if (checkOnly)
      console.error(
        'Run `npm run domains:sync` and commit the result; foreign URLs need a manual fix.'
      );
    process.exit(1);
  }
}

main();
