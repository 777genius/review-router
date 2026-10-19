/**
 * Managed OCR bootstrap helpers (plan 56, §4.2, §5.1, §5.2).
 *
 * Captured agentKind=ocr dispatch happens before any Codex CLI effect. The
 * approved binary is digest- and version-verified before use; the private run
 * directory and child HOME are 0700 and HOME/.opencodereview/config.json is
 * 0600 with only the controlled reviewrouter provider. Cleanup removes the
 * whole private run directory and also runs on cache-hit/early-exit paths.
 */

import { execFile } from 'child_process';
import { createHash } from 'node:crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  assertApprovedReviewAgentBinary,
  assertApprovedReviewAgentVersion,
} from '../control-plane/approved-review-agent';
import { buildOcrManagedConfigJson } from '../review-orchestration/infrastructure/ocr-review-managed-run';

/**
 * Strict OCR side of the approved agent profile contract (§4.1): the same
 * seven keys; contextGateway is a real false for ocr, modelTransports only
 * account_gateway. The generated strict parser remains the single authority
 * for codex/claude profiles; this boundary mirrors the generated OCR union
 * until the shared generator is regenerated.
 */
export type ApprovedOcrReviewAgent = Readonly<{
  profileRef: string;
  agentKind: 'ocr';
  binarySha256: string;
  packageVersion: string;
  modelTransports: readonly ['account_gateway'];
  contextGateway: false;
  cancellation: true;
}>;

/** Digest-checked agent kind peek used to dispatch before Codex effects. */
export function readApprovedReviewAgentKind(
  json: string,
  digest: string
): 'codex' | 'claude' | 'ocr' {
  if (
    Buffer.byteLength(json) > 16384 ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    createHash('sha256').update(json).digest('hex') !== digest
  ) {
    throw new Error('review_agent_profile_digest_mismatch');
  }
  const row = JSON.parse(json) as Record<string, unknown> | null;
  const kind = row?.agentKind;
  if (kind !== 'codex' && kind !== 'claude' && kind !== 'ocr') {
    throw new Error('review_agent_profile_invalid');
  }
  return kind;
}

export function readApprovedOcrReviewAgent(
  json: string,
  digest: string
): ApprovedOcrReviewAgent {
  if (readApprovedReviewAgentKind(json, digest) !== 'ocr') {
    throw new Error('review_agent_profile_invalid');
  }
  const row = JSON.parse(json) as Record<string, unknown>;
  const keys = [
    'agentKind',
    'binarySha256',
    'cancellation',
    'contextGateway',
    'modelTransports',
    'packageVersion',
    'profileRef',
  ];
  const transports = row.modelTransports;
  if (
    Object.keys(row).sort().join(',') !== keys.join(',') ||
    typeof row.profileRef !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(row.profileRef) ||
    typeof row.binarySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.binarySha256) ||
    typeof row.packageVersion !== 'string' ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(row.packageVersion) ||
    row.contextGateway !== false ||
    row.cancellation !== true ||
    !Array.isArray(transports) ||
    transports.length !== 1 ||
    transports[0] !== 'account_gateway'
  ) {
    throw new Error('review_agent_profile_capabilities_invalid');
  }
  return Object.freeze({
    profileRef: row.profileRef,
    agentKind: 'ocr',
    binarySha256: row.binarySha256,
    packageVersion: row.packageVersion,
    modelTransports: Object.freeze(['account_gateway']) as ['account_gateway'],
    contextGateway: false,
    cancellation: true,
  });
}

/**
 * Resolve and verify the approved OCR binary (digest + version) before any
 * checkout, model or run-dir effect (§5.2). Local runs supply the pinned
 * binary via REVIEWROUTER_OCR_BINARY; there is no PATH search here. The
 * release-owned pinned asset install feeds the same verification.
 */
/** `--version` prints "<name> <version> <goos>/<goarch>"; take the version token. */
function extractReportedVersion(stdout: string): string {
  const tokens = (stdout.split('\n')[0] ?? '').trim().split(/\s+/u);
  const versions = tokens.filter((token) =>
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(token)
  );
  return versions.length === 1 ? versions[0]! : tokens.join(' ');
}

export async function verifyApprovedOcrBinary(input: {
  readonly approvedAgent: ApprovedOcrReviewAgent;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = input.env ?? process.env;
  const binaryPath = env.REVIEWROUTER_OCR_BINARY;
  if (!binaryPath || !path.isAbsolute(binaryPath)) {
    throw new Error('review_action_v2_ocr_binary_unavailable');
  }
  input.signal?.throwIfAborted();
  const binaryBytes = await fs.readFile(binaryPath);
  assertApprovedReviewAgentBinary(input.approvedAgent, binaryBytes);
  const version = await promisify(execFile)(binaryPath, ['--version'], {
    signal: input.signal,
    killSignal: 'SIGKILL',
    timeout: 10_000,
    maxBuffer: 16_384,
    env: { PATH: env.PATH, HOME: os.tmpdir() },
  });
  assertApprovedReviewAgentVersion(
    input.approvedAgent,
    extractReportedVersion(version.stdout)
  );
  input.signal?.throwIfAborted();
  return binaryPath;
}

export type OcrManagedRunHandle = Readonly<{
  binaryPath: string;
  runDirectory: string;
  homeDirectory: string;
  configPath: string;
  rulePath: string;
  /** Always allocated 0600 in the private run dir; content written at prepare. */
  backgroundPath: string;
  /** Idempotent; also runs on cache-hit and failure paths (§5.2). */
  cleanup: () => Promise<void>;
}>;

/**
 * Verify the approved binary and prepare the private run layout (§5.2).
 * Local runs supply the pinned binary via REVIEWROUTER_OCR_BINARY; there is
 * no PATH search and no "latest" download here. The release-owned pinned
 * asset install feeds the same verification before activation.
 */
export async function prepareOcrManagedRun(input: {
  readonly approvedAgent: ApprovedOcrReviewAgent;
  readonly baseUrl: string;
  readonly rawCapability: string;
  readonly model: string;
  readonly requestTimeoutSec: number;
  readonly modelReasoningEffort: string | null;
  readonly language: string | null;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: { readonly info: (message: string) => void };
}): Promise<OcrManagedRunHandle> {
  const env = input.env ?? process.env;
  const binaryPath = await verifyApprovedOcrBinary({
    approvedAgent: input.approvedAgent,
    ...(input.signal ? { signal: input.signal } : {}),
    env,
  });
  const runDirectory = await fs.mkdtemp(
    path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'reviewrouter-ocr-run-')
  );
  try {
    await fs.chmod(runDirectory, 0o700);
    const homeDirectory = path.join(runDirectory, 'home');
    await fs.mkdir(path.join(homeDirectory, '.opencodereview'), {
      recursive: true,
      mode: 0o700,
    });
    await fs.chmod(homeDirectory, 0o700);
    const configPath = path.join(homeDirectory, '.opencodereview', 'config.json');
    await fs.writeFile(
      configPath,
      buildOcrManagedConfigJson({
        baseUrl: input.baseUrl,
        rawCapability: input.rawCapability,
        model: input.model,
        limits: { requestTimeoutSec: input.requestTimeoutSec },
        modelReasoningEffort: input.modelReasoningEffort,
        language: input.language,
      }),
      { mode: 0o600 }
    );
    const rulePath = path.join(runDirectory, 'rule.json');
    await fs.writeFile(rulePath, '', { mode: 0o600 });
    const backgroundPath = path.join(runDirectory, 'background.md');
    await fs.writeFile(backgroundPath, '', { mode: 0o600 });
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      await fs.rm(runDirectory, { recursive: true, force: true });
    };
    return Object.freeze({
      binaryPath,
      runDirectory,
      homeDirectory,
      configPath,
      rulePath,
      backgroundPath,
      cleanup,
    });
  } catch (error) {
    // A failed layout never leaks a private directory (§5.2).
    await fs.rm(runDirectory, { recursive: true, force: true });
    throw error;
  }
}
