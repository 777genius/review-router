/**
 * Plan 56 §5.2 managed OCR bootstrap: digest- and version-verified approved
 * binary, private run directory (HOME 0700, config.json 0600) and cleanup
 * that also runs on cache-hit/early-exit paths.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  prepareOcrManagedRun,
  readApprovedOcrReviewAgent,
  readApprovedReviewAgentKind,
  verifyApprovedOcrBinary,
  type ApprovedOcrReviewAgent,
} from '../../../src/codex-oauth/ocr-managed-bootstrap';

function profileJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    profileRef: 'ocr-managed-v1',
    agentKind: 'ocr',
    binarySha256: '1'.repeat(64),
    packageVersion: '1.2.3',
    modelTransports: ['account_gateway'],
    contextGateway: false,
    cancellation: true,
    ...overrides,
  });
}

function digestOf(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

describe('approved OCR profile parser (§4.1 seven keys)', () => {
  it('accepts the strict OCR union with a real contextGateway=false', () => {
    const json = profileJson();
    const profile = readApprovedOcrReviewAgent(json, digestOf(json));
    expect(profile.agentKind).toBe('ocr');
    expect(profile.contextGateway).toBe(false);
    expect(profile.modelTransports).toEqual(['account_gateway']);
  });

  it('peeks the captured agentKind before any Codex effect', () => {
    const json = profileJson();
    expect(readApprovedReviewAgentKind(json, digestOf(json))).toBe('ocr');
    const codex = profileJson({ agentKind: 'codex' });
    expect(readApprovedReviewAgentKind(codex, digestOf(codex))).toBe('codex');
  });

  it('rejects a digest mismatch before interpreting the profile', () => {
    const json = profileJson();
    expect(() => readApprovedReviewAgentKind(json, '0'.repeat(64))).toThrow(
      'review_agent_profile_digest_mismatch'
    );
    expect(() =>
      readApprovedOcrReviewAgent(json, '0'.repeat(64))
    ).toThrow('review_agent_profile_digest_mismatch');
  });

  it.each([
    ['hardcoded contextGateway=true', { contextGateway: true }],
    ['non-ocr agentKind', { agentKind: 'codex' }],
    ['extra transport', { modelTransports: ['account_gateway', 'codex_cli'] }],
    ['non-semver packageVersion', { packageVersion: 'dev' }],
    ['extra profile key', { extraKey: 'x' }],
    ['missing cancellation', { cancellation: false }],
  ])('rejects %s', (_label, overrides) => {
    const json = profileJson(overrides);
    expect(() => readApprovedOcrReviewAgent(json, digestOf(json))).toThrow(
      /review_agent_profile_/u
    );
  });
});

describe('verifyApprovedOcrBinary / prepareOcrManagedRun (§5.2)', () => {
  let workspace: string;
  let binaryPath: string;
  let approvedAgent: ApprovedOcrReviewAgent;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ocr-bootstrap-'));
    binaryPath = path.join(workspace, 'opencodereview');
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho "ocr-fake 1.2.3"\n', {
      mode: 0o755,
    });
    const bytes = fs.readFileSync(binaryPath);
    approvedAgent = {
      profileRef: 'ocr-managed-v1',
      agentKind: 'ocr',
      binarySha256: createHash('sha256').update(bytes).digest('hex'),
      packageVersion: '1.2.3',
      modelTransports: ['account_gateway'],
      contextGateway: false,
      cancellation: true,
    };
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('verifies binary digest and version before any run layout effect', async () => {
    const resolved = await verifyApprovedOcrBinary({
      approvedAgent,
      env: { REVIEWROUTER_OCR_BINARY: binaryPath, PATH: process.env.PATH },
    });
    expect(resolved).toBe(binaryPath);
  });

  it('accepts the real --version line shape (name, version, platform)', async () => {
    const shapedPath = path.join(workspace, 'shaped');
    fs.writeFileSync(
      shapedPath,
      '#!/bin/sh\necho "open-code-review 1.2.3 darwin/arm64"\n',
      { mode: 0o755 }
    );
    const bytes = fs.readFileSync(shapedPath);
    const resolved = await verifyApprovedOcrBinary({
      approvedAgent: {
        ...approvedAgent,
        binarySha256: createHash('sha256').update(bytes).digest('hex'),
      },
      env: { REVIEWROUTER_OCR_BINARY: shapedPath, PATH: process.env.PATH },
    });
    expect(resolved).toBe(shapedPath);
  });

  it('rejects binary drift and missing/relative paths', async () => {
    await expect(
      verifyApprovedOcrBinary({
        approvedAgent: { ...approvedAgent, binarySha256: '2'.repeat(64) },
        env: { REVIEWROUTER_OCR_BINARY: binaryPath, PATH: process.env.PATH },
      })
    ).rejects.toThrow('review_agent_binary_drift');
    await expect(
      verifyApprovedOcrBinary({
        approvedAgent,
        env: { REVIEWROUTER_OCR_BINARY: 'relative/path', PATH: process.env.PATH },
      })
    ).rejects.toThrow('review_action_v2_ocr_binary_unavailable');
    await expect(
      verifyApprovedOcrBinary({
        approvedAgent,
        env: { PATH: process.env.PATH },
      })
    ).rejects.toThrow('review_action_v2_ocr_binary_unavailable');
  });

  it('rejects version drift after digest verification', async () => {
    const driftedPath = path.join(workspace, 'drifted');
    fs.writeFileSync(driftedPath, '#!/bin/sh\necho "ocr-fake 9.9.9"\n', {
      mode: 0o755,
    });
    const bytes = fs.readFileSync(driftedPath);
    await expect(
      verifyApprovedOcrBinary({
        approvedAgent: {
          ...approvedAgent,
          binarySha256: createHash('sha256').update(bytes).digest('hex'),
        },
        env: { REVIEWROUTER_OCR_BINARY: driftedPath, PATH: process.env.PATH },
      })
    ).rejects.toThrow('review_agent_version_drift');
  });

  it('creates a private run layout with 0700 HOME and 0600 config', async () => {
    const handle = await prepareOcrManagedRun({
      approvedAgent,
      baseUrl: 'http://127.0.0.1:41000',
      rawCapability: 'a'.repeat(64),
      model: 'admitted-model',
      requestTimeoutSec: 600,
      modelReasoningEffort: 'medium',
      language: 'en',
      env: { REVIEWROUTER_OCR_BINARY: binaryPath, PATH: process.env.PATH },
    });
    try {
      const runMode = fs.statSync(handle.runDirectory).mode & 0o777;
      const homeMode = fs.statSync(handle.homeDirectory).mode & 0o777;
      const configMode = fs.statSync(handle.configPath).mode & 0o777;
      expect(runMode).toBe(0o700);
      expect(homeMode).toBe(0o700);
      expect(configMode).toBe(0o600);
      const config = JSON.parse(fs.readFileSync(handle.configPath, 'utf8'));
      expect(config.provider).toBe('reviewrouter');
      expect(Object.keys(config.custom_providers)).toEqual(['reviewrouter']);
      expect(config.custom_providers.reviewrouter.url).toBe(
        'http://127.0.0.1:41000'
      );
    } finally {
      await handle.cleanup();
    }
  });

  it('cleans up the whole run directory on cache-hit/early-exit paths, idempotently', async () => {
    // Cache hit: the lookup satisfies the slot, so no OCR run and no model
    // request ever happens — but the private run layout still gets cleaned.
    const handle = await prepareOcrManagedRun({
      approvedAgent,
      baseUrl: 'http://127.0.0.1:41000',
      rawCapability: 'a'.repeat(64),
      model: 'admitted-model',
      requestTimeoutSec: 600,
      modelReasoningEffort: null,
      language: null,
      env: { REVIEWROUTER_OCR_BINARY: binaryPath, PATH: process.env.PATH },
    });
    expect(fs.existsSync(handle.runDirectory)).toBe(true);
    await handle.cleanup();
    expect(fs.existsSync(handle.runDirectory)).toBe(false);
    await handle.cleanup();
    expect(fs.existsSync(handle.runDirectory)).toBe(false);
  });
});

describe('managed config hardening in the bootstrap path', () => {
  it('rejects an ambient/inherited capability format before writing config', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ocr-bootstrap-'));
    const binaryPath = path.join(workspace, 'opencodereview');
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho "ocr-fake 1.2.3"\n', {
      mode: 0o755,
    });
    const bytes = fs.readFileSync(binaryPath);
    const approvedAgent: ApprovedOcrReviewAgent = {
      profileRef: 'ocr-managed-v1',
      agentKind: 'ocr',
      binarySha256: createHash('sha256').update(bytes).digest('hex'),
      packageVersion: '1.2.3',
      modelTransports: ['account_gateway'],
      contextGateway: false,
      cancellation: true,
    };
    try {
      await expect(
        prepareOcrManagedRun({
          approvedAgent,
          baseUrl: 'http://127.0.0.1:41000',
          rawCapability: 'Bearer b'.repeat(1) + 'a'.repeat(64),
          model: 'admitted-model',
          requestTimeoutSec: 600,
          modelReasoningEffort: null,
          language: null,
          env: { REVIEWROUTER_OCR_BINARY: binaryPath, PATH: process.env.PATH },
        })
      ).rejects.toThrow('review_action_v2_ocr_config_capability_invalid');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('local harness wiring sanity', () => {
  it('the fixture fake binary is executable like the pinned asset', () => {
    // Guard against test environments where execFile bits were lost.
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ocr-exec-'));
    const script = path.join(probe, 'x');
    fs.writeFileSync(script, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    expect(execFileSync(script, [], { encoding: 'utf8' }).trim()).toBe('ok');
    fs.rmSync(probe, { recursive: true, force: true });
  });
});
