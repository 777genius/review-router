/** Rewrites ReviewRouter domain literals in workflow and shell files to the
 * canonical origins in src/config/review-router-endpoints.json. YAML and bash
 * cannot import shared modules, so those files carry literals and this script
 * is their sync tool. Usage: node scripts/sync-review-router-domains.mts [--check].
 * A future domain outside the reviewrouter.* family needs its pattern added
 * below. Generated JSON Schema `$id` namespaces never follow these origins and
 * are outside the target list on purpose. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const endpoints = JSON.parse(
  fs.readFileSync(
    new URL('../src/config/review-router-endpoints.json', import.meta.url),
    'utf8'
  )
) as { webOrigin: string; apiOrigin: string };
const REVIEW_ROUTER_WEB_ORIGIN = endpoints.webOrigin;
const REVIEW_ROUTER_API_ORIGIN = endpoints.apiOrigin;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const TARGET_FILES = [
  '.github/workflows/reviewrouter-reusable.yml',
  '.github/workflows/reviewrouter-interaction-reusable.yml',
  '.github/workflows/reviewrouter-t0-reusable.yml',
  '.github/workflows/reviewrouter-runtime.yml',
  '.github/workflows/reviewrouter.yml',
  'scripts/seed-codex-auth.sh',
  'scripts/reseed-codex-rotating-auth.sh',
];

const API_ORIGIN_PATTERN =
  /https:\/\/api\.reviewrouter\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g;
const WEB_ORIGIN_PATTERN =
  /https:\/\/reviewrouter\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g;

function syncContent(content: string): string {
  return content
    .replace(API_ORIGIN_PATTERN, REVIEW_ROUTER_API_ORIGIN)
    .replace(WEB_ORIGIN_PATTERN, REVIEW_ROUTER_WEB_ORIGIN);
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const stale: string[] = [];
  for (const file of TARGET_FILES) {
    const absolute = path.join(repoRoot, file);
    const current = fs.readFileSync(absolute, 'utf8');
    const updated = syncContent(current);
    if (updated === current) continue;
    stale.push(file);
    if (!checkOnly) fs.writeFileSync(absolute, updated);
  }
  if (stale.length === 0) return;
  for (const file of stale)
    console.log(
      checkOnly ? `stale domain literals: ${file}` : `domain literals synced: ${file}`
    );
  if (checkOnly) {
    console.error('Run `npm run domains:sync` and commit the result.');
    process.exit(1);
  }
}

main();
