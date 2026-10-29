import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REVIEW_ROUTER_API_ORIGIN,
  REVIEW_ROUTER_WEB_ORIGIN,
  CODEX_SEED_SCRIPT_URL,
  NEWTEST_V4_ROOT_URL,
} from '../../../src/config/review-router-endpoints';

const repoRoot = path.resolve(__dirname, '../../..');
const syncScript = path.join(
  repoRoot,
  'scripts/sync-review-router-domains.mjs'
);

const ORIGIN_PATTERN =
  /https:\/\/(?:api\.)?reviewrouter\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/;

function runSync(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [syncScript, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
}

function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated') continue;
      files.push(...walkTypeScriptFiles(entryPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

function buildDomainFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-domains-'));
  const targets: Record<string, string> = {
    '.github/workflows/reviewrouter-reusable.yml':
      '        default: https://other.invalid\n',
    '.github/workflows/reviewrouter-interaction-reusable.yml': '',
    '.github/workflows/reviewrouter-t0-reusable.yml':
      '      api_url: https://api.reviewrouter.site\n',
    '.github/workflows/reviewrouter-runtime.yml':
      '# see https://other.invalid for details\n',
    '.github/workflows/reviewrouter.yml': '',
    'scripts/seed-codex-auth.sh': '',
    'scripts/reseed-codex-rotating-auth.sh': '',
  };
  for (const [file, content] of Object.entries(targets)) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return root;
}

describe('review-router domain single source', () => {
  it('keeps workflow and shell domain literals in sync with the canonical origins', () => {
    const result = runSync(['--check']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('derives all endpoint URLs from the canonical origins', () => {
    expect(CODEX_SEED_SCRIPT_URL).toBe(
      `${REVIEW_ROUTER_WEB_ORIGIN}/install/codex`
    );
    expect(NEWTEST_V4_ROOT_URL).toBe(
      `${REVIEW_ROUTER_API_ORIGIN}/__newtest_v4/`
    );
  });

  it('rejects stale managed fields and foreign URLs instead of treating them as in sync', () => {
    const root = buildDomainFixtureRoot();
    try {
      const result = runSync(['--check'], {
        REVIEW_ROUTER_DOMAINS_ROOT: root,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('stale domain literals');
      expect(result.stdout).toContain('reviewrouter-reusable.yml');
      expect(result.stdout).toContain('reviewrouter-t0-reusable.yml');
      expect(result.stdout).toContain('foreign URL');
      expect(result.stdout).toContain('https://other.invalid');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('has no raw domain literals in src TypeScript outside generated schemas', () => {
    const offenders = walkTypeScriptFiles(path.join(repoRoot, 'src')).filter(
      (file) => ORIGIN_PATTERN.test(fs.readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
