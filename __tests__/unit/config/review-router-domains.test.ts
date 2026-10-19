import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  REVIEW_ROUTER_API_ORIGIN,
  REVIEW_ROUTER_WEB_ORIGIN,
  CODEX_SEED_SCRIPT_URL,
  NEWTEST_V4_ROOT_URL,
} from '../../../src/config/review-router-endpoints';

const repoRoot = path.resolve(__dirname, '../../..');

const ORIGIN_PATTERN =
  /https:\/\/(?:api\.)?reviewrouter\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/;

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

describe('review-router domain single source', () => {
  it('keeps workflow and shell domain literals in sync with the canonical origins', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/sync-review-router-domains.mts'), '--check'],
      { encoding: 'utf8', cwd: repoRoot }
    );
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

  it('has no raw domain literals in src TypeScript outside generated schemas', () => {
    const offenders = walkTypeScriptFiles(path.join(repoRoot, 'src')).filter(
      (file) => ORIGIN_PATTERN.test(fs.readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
