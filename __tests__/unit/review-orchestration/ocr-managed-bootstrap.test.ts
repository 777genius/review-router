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
  OCR_BINARY_ASSET_LIMIT_BYTES,
  prepareOcrManagedRun,
  resolveApprovedOcrBinary,
  readApprovedOcrReviewAgent,
  readApprovedReviewAgentKind,
  verifyApprovedOcrBinary,
  type ApprovedOcrReviewAgent,
} from '../../../src/codex-oauth/ocr-managed-bootstrap';
import { buildOcrManagedConfigJson } from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';
import { GATEWAY_CODEX_MODEL_SETTINGS_ENV } from '../../../src/control-plane/admitted-gateway-codex-model-settings';

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

describe('approved OCR profile parser (legacy plus optional Skills capability)', () => {
  it('accepts the strict OCR union with a real contextGateway=false', () => {
    const json = profileJson();
    const profile = readApprovedOcrReviewAgent(json, digestOf(json));
    expect(profile.agentKind).toBe('ocr');
    expect(profile.contextGateway).toBe(false);
    expect(profile.modelTransports).toEqual(['account_gateway']);
  });

  it('preserves explicit capability and leaves legacy absence byte-compatible', () => {
    const legacyJson = profileJson();
    expect(
      readApprovedOcrReviewAgent(legacyJson, digestOf(legacyJson))
    ).not.toHaveProperty('reviewSkillsVersion');
    const supporting = profileJson({ reviewSkillsVersion: 1 });
    expect(
      readApprovedOcrReviewAgent(supporting, digestOf(supporting))
        .reviewSkillsVersion
    ).toBe(1);
    for (const value of [null, false, 2, '1']) {
      const invalid = profileJson({ reviewSkillsVersion: value });
      expect(() =>
        readApprovedOcrReviewAgent(invalid, digestOf(invalid))
      ).toThrow('review_agent_profile_capabilities_invalid');
    }
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
    expect(() => readApprovedOcrReviewAgent(json, '0'.repeat(64))).toThrow(
      'review_agent_profile_digest_mismatch'
    );
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
        env: {
          REVIEWROUTER_OCR_BINARY: 'relative/path',
          PATH: process.env.PATH,
        },
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

  it.each([
    { reasoning: null, saved: 'high', expected: undefined },
    {
      reasoning: { allowed: ['minimal', 'high'], default: 'minimal' },
      saved: 'high',
      expected: { effort: 'high' },
    },
    {
      reasoning: { allowed: ['minimal', 'high'], default: 'minimal' },
      saved: null,
      expected: { effort: 'minimal' },
    },
  ])(
    'uses admitted model reasoning in initial and context-tools configs %#',
    async ({ reasoning, saved, expected }) => {
      const admittedRuntimeConfig = {
        protocolVersion: 1 as const,
        configVersion: 1,
        runtimeEnv: {
          CODEX_MODEL: 'admitted-model',
          [GATEWAY_CODEX_MODEL_SETTINGS_ENV]: JSON.stringify({
            model: 'admitted-model',
            reasoning,
          }),
        },
      };
      const input = {
        approvedAgent,
        baseUrl: 'http://127.0.0.1:41000',
        rawCapability: 'a'.repeat(64),
        model: 'admitted-model',
        requestTimeoutSec: 600,
        modelReasoningEffort: saved,
        admittedRuntimeConfig,
        language: 'en',
        env: { REVIEWROUTER_OCR_BINARY: binaryPath, PATH: process.env.PATH },
      };
      const handle = await prepareOcrManagedRun(input);
      try {
        const initial = JSON.parse(fs.readFileSync(handle.configPath, 'utf8'));
        const rewrite = JSON.parse(
          buildOcrManagedConfigJson({
            ...input,
            limits: { requestTimeoutSec: input.requestTimeoutSec },
            contextTools: {
              url: 'http://127.0.0.1:41001/mcp',
              capability: 'b'.repeat(64),
              tools: ['approved_context_tool'],
            },
          })
        );
        for (const config of [initial, rewrite]) {
          const extra = config.custom_providers.reviewrouter.extra_body;
          expect(extra.reasoning).toEqual(expected);
          expect(Object.hasOwn(extra, 'reasoning')).toBe(
            expected !== undefined
          );
        }
        expect(rewrite.mcp_servers.reviewrouter_context.tools).toEqual([
          'approved_context_tool',
        ]);
      } finally {
        await handle.cleanup();
      }
    }
  );

  it('rejects foreign admitted model settings before creating managed configuration', async () => {
    const input = {
      approvedAgent,
      baseUrl: 'http://127.0.0.1:41000',
      rawCapability: 'a'.repeat(64),
      model: 'admitted-model',
      requestTimeoutSec: 600,
      modelReasoningEffort: 'high',
      admittedRuntimeConfig: {
        protocolVersion: 1 as const,
        configVersion: 1,
        runtimeEnv: {
          [GATEWAY_CODEX_MODEL_SETTINGS_ENV]: JSON.stringify({
            model: 'foreign-model',
            reasoning: null,
          }),
        },
      },
      language: null,
      env: { REVIEWROUTER_OCR_BINARY: binaryPath, PATH: process.env.PATH },
    };
    const prepared = prepareOcrManagedRun(input);
    try {
      await expect(prepared).rejects.toThrow(
        'account_gateway_codex_model_settings_invalid'
      );
      expect(() =>
        buildOcrManagedConfigJson({
          ...input,
          limits: { requestTimeoutSec: 600 },
        })
      ).toThrow('account_gateway_codex_model_settings_invalid');
    } finally {
      await prepared.then(
        (handle) => handle.cleanup(),
        () => undefined
      );
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

describe('run-owned approved OCR release assets', () => {
  let workspace: string;
  let env: NodeJS.ProcessEnv;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  const bytes = Buffer.from('#!/bin/sh\necho "ocr-fake 1.2.3"\n');
  const approvedAgent = readApprovedOcrReviewAgent(
    profileJson({
      binarySha256: createHash('sha256').update(bytes).digest('hex'),
    }),
    digestOf(
      profileJson({
        binarySha256: createHash('sha256').update(bytes).digest('hex'),
      })
    )
  );

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ocr-asset-'));
    env = { RUNNER_TEMP: workspace, PATH: process.env.PATH };
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
    jest.restoreAllMocks();
    jest.useRealTimers();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('downloads the versioned public asset, verifies it, and removes only its private copy', async () => {
    const fetchImpl: jest.MockedFunction<typeof fetch> = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(async () => new Response(bytes));
    const handle = await resolveApprovedOcrBinary({
      approvedAgent,
      env,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://github.com/777genius/review-router/releases/download/ocr-v1.2.3/opencodereview-linux-amd64'
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
    expect(fs.readFileSync(handle.binaryPath)).toEqual(bytes);
    expect(fs.statSync(path.dirname(handle.binaryPath)).mode & 0o777).toBe(
      0o700
    );
    expect(fs.statSync(handle.binaryPath).mode & 0o777).toBe(0o700);
    // Reusing the captured path for prepare performs no second download.
    expect(
      await verifyApprovedOcrBinary({
        approvedAgent,
        env: { ...env, REVIEWROUTER_OCR_BINARY: handle.binaryPath },
      })
    ).toBe(handle.binaryPath);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await handle.cleanup();
    await handle.cleanup();
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('preserves an explicit absolute binary override without downloading or removing it', async () => {
    const binaryPath = path.join(workspace, 'existing');
    fs.writeFileSync(binaryPath, bytes, { mode: 0o700 });
    const fetchImpl: jest.MockedFunction<typeof fetch> = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();
    const handle = await resolveApprovedOcrBinary({
      approvedAgent,
      env: { ...env, REVIEWROUTER_OCR_BINARY: binaryPath },
      fetchImpl,
    });
    await handle.cleanup();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(binaryPath)).toBe(true);
    await expect(
      resolveApprovedOcrBinary({
        approvedAgent,
        env: { ...env, REVIEWROUTER_OCR_BINARY: 'relative' },
        fetchImpl,
      })
    ).rejects.toThrow('review_action_v2_ocr_binary_unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['digest', 'version'] as const)(
    'cleans failed %s verification and never executes a digest mismatch',
    async (failure) => {
      const marker = path.join(workspace, 'executed');
      const candidate = Buffer.from(
        `#!/bin/sh\necho executed > '${marker}'\necho "ocr-fake 9.9.9"\n`
      );
      const fetchImpl: jest.MockedFunction<typeof fetch> = jest.fn<
        ReturnType<typeof fetch>,
        Parameters<typeof fetch>
      >(async () => new Response(candidate));
      const profile =
        failure === 'digest'
          ? approvedAgent
          : {
              ...approvedAgent,
              binarySha256: createHash('sha256')
                .update(candidate)
                .digest('hex'),
            };
      await expect(
        resolveApprovedOcrBinary({ approvedAgent: profile, env, fetchImpl })
      ).rejects.toThrow(
        failure === 'digest'
          ? 'review_agent_binary_drift'
          : 'review_agent_version_drift'
      );
      expect(fs.existsSync(marker)).toBe(failure === 'version');
      expect(fs.readdirSync(workspace)).toEqual(
        failure === 'version' ? ['executed'] : []
      );
    }
  );

  it('bounds actual streamed bytes even without a content length, then cancels and removes the partial asset', async () => {
    const cancelled = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(OCR_BINARY_ASSET_LIMIT_BYTES + 1));
      },
      cancel: cancelled,
    });
    const fetchImpl: jest.MockedFunction<typeof fetch> = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(async () => new Response(body));
    await expect(
      resolveApprovedOcrBinary({ approvedAgent, env, fetchImpl })
    ).rejects.toThrow('review_action_v2_ocr_asset_too_large');
    expect(cancelled).toHaveBeenCalled();
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('cancels an unfinished response body and closes its private output on root abort', async () => {
    let reading!: () => void;
    const ready = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const cancelled = jest.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull: reading,
        cancel: cancelled,
      },
      { highWaterMark: 0 }
    );
    const fetchImpl: jest.MockedFunction<typeof fetch> = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(async () => new Response(body));
    const controller = new AbortController();
    const pending = resolveApprovedOcrBinary({
      approvedAgent,
      env,
      fetchImpl,
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow('fixture_body_cancelled');
    await ready;
    controller.abort(new Error('fixture_body_cancelled'));
    await rejected;
    expect(cancelled).toHaveBeenCalled();
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it.each(['root', 'deadline'] as const)(
    'cancels a pending download on %s and cleans its private directory',
    async (cause) => {
      if (cause === 'deadline') jest.useFakeTimers();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const controller = new AbortController();
      const fetchImpl: jest.MockedFunction<typeof fetch> = jest.fn<
        ReturnType<typeof fetch>,
        Parameters<typeof fetch>
      >(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => reject(init!.signal!.reason),
              { once: true }
            );
            started();
          })
      );
      const pending = resolveApprovedOcrBinary({
        approvedAgent,
        env,
        signal: controller.signal,
        fetchImpl,
      });
      const rejected = expect(pending).rejects.toThrow(
        cause === 'root'
          ? 'fixture_cancelled'
          : 'review_action_v2_ocr_asset_download_timeout'
      );
      await ready;
      if (cause === 'root') controller.abort(new Error('fixture_cancelled'));
      else await jest.advanceTimersByTimeAsync(120_000);
      await rejected;
      expect(fs.readdirSync(workspace)).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects an unsafe release version before any download or filesystem effect', async () => {
    const fetchImpl: jest.MockedFunction<typeof fetch> = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();
    await expect(
      resolveApprovedOcrBinary({
        approvedAgent: {
          ...approvedAgent,
          packageVersion: '1.2.3/../../latest',
        },
        env,
        fetchImpl,
      })
    ).rejects.toThrow('review_action_v2_ocr_asset_identity_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
});

describe('managed config hardening in the bootstrap path', () => {
  it('rejects an ambient/inherited capability format before writing config', async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rr-ocr-bootstrap-')
    );
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
