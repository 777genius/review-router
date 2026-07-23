import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import generatedManifest from './generated/review-action-v2/manifest.json';
import {
  reviewActionV2CanonicalizerDigest,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
} from './generated/review-action-v2/review-action-v2';

const HANDOFF_MANIFEST_FILE = 'handoff-manifest.json';
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export enum ReviewActionV2RuntimeMode {
  Disabled = 'disabled',
  T0 = 't0',
}

export type VerifiedReviewActionV2Handoff = {
  readonly saasSourceCommit: string;
  readonly expectedPublicActionBaseCommit: string;
  readonly schemaDigest: string;
  readonly canonicalizerDigest: string;
  readonly goldenFixtureDigest: string;
  readonly generatedFileCount: number;
};

export type ReviewActionV2Activation =
  | { readonly mode: ReviewActionV2RuntimeMode.Disabled }
  | {
      readonly mode: ReviewActionV2RuntimeMode.T0;
      readonly handoff: VerifiedReviewActionV2Handoff;
    };

export function resolveReviewActionV2Activation(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly generatedRoot?: string;
  } = {}
): ReviewActionV2Activation {
  const rawMode = input.env?.REVIEWROUTER_ACTION_V2_MODE?.trim() ?? '';
  if (rawMode === '' || rawMode === ReviewActionV2RuntimeMode.Disabled) {
    return { mode: ReviewActionV2RuntimeMode.Disabled };
  }
  if (rawMode !== ReviewActionV2RuntimeMode.T0) {
    throw new Error('review_action_v2_mode_invalid');
  }
  return {
    mode: ReviewActionV2RuntimeMode.T0,
    handoff: verifyReviewActionV2Handoff(
      input.generatedRoot ?? locateGeneratedContractRoot()
    ),
  };
}

export function verifyReviewActionV2Handoff(
  generatedRoot: string
): VerifiedReviewActionV2Handoff {
  const handoffPath = path.join(generatedRoot, HANDOFF_MANIFEST_FILE);
  if (!existsSync(handoffPath) || !lstatSync(handoffPath).isFile()) {
    throw new Error('review_action_v2_handoff_manifest_missing');
  }
  const raw = readFileSync(handoffPath, 'utf8');
  const value = parseCanonicalObject(raw);
  assertExactKeys(value, [
    'canonicalizerDigest',
    'contractExportVersion',
    'expectedPublicActionBaseCommit',
    'generatedFileDigests',
    'goldenFixtureDigest',
    'protocolVersion',
    'saasSourceCommit',
    'schemaDigest',
  ]);
  if (value.contractExportVersion !== 1) {
    throw new Error('review_action_v2_handoff_version_invalid');
  }
  if (
    value.protocolVersion !== reviewActionV2PublishedProtocolVersion ||
    value.protocolVersion !== generatedManifest.protocolVersion ||
    value.schemaDigest !== reviewActionV2PublishedSchemaDigest ||
    value.schemaDigest !== generatedManifest.schemaDigest ||
    value.canonicalizerDigest !== reviewActionV2CanonicalizerDigest ||
    value.canonicalizerDigest !== generatedManifest.canonicalizerDigest ||
    value.goldenFixtureDigest !== generatedManifest.goldenFixtureDigest
  ) {
    throw new Error('review_action_v2_handoff_contract_mismatch');
  }
  if (
    typeof value.saasSourceCommit !== 'string' ||
    !SHA_PATTERN.test(value.saasSourceCommit) ||
    typeof value.expectedPublicActionBaseCommit !== 'string' ||
    !SHA_PATTERN.test(value.expectedPublicActionBaseCommit)
  ) {
    throw new Error('review_action_v2_handoff_commit_invalid');
  }
  if (!isRecord(value.generatedFileDigests)) {
    throw new Error('review_action_v2_handoff_file_digests_invalid');
  }

  const actualFiles = listRegularFiles(generatedRoot).filter(
    (file) => file !== HANDOFF_MANIFEST_FILE
  );
  const expectedFiles = Object.keys(value.generatedFileDigests).sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    throw new Error('review_action_v2_handoff_file_set_mismatch');
  }
  for (const file of actualFiles) {
    const expectedDigest = value.generatedFileDigests[file];
    if (
      typeof expectedDigest !== 'string' ||
      !DIGEST_PATTERN.test(expectedDigest) ||
      sha256(readFileSync(path.join(generatedRoot, ...file.split('/')))) !==
        expectedDigest
    ) {
      throw new Error('review_action_v2_handoff_file_digest_mismatch');
    }
  }

  return {
    saasSourceCommit: value.saasSourceCommit,
    expectedPublicActionBaseCommit: value.expectedPublicActionBaseCommit,
    schemaDigest: value.schemaDigest as string,
    canonicalizerDigest: value.canonicalizerDigest as string,
    goldenFixtureDigest: value.goldenFixtureDigest as string,
    generatedFileCount: actualFiles.length,
  };
}

function locateGeneratedContractRoot(): string {
  const candidates = [
    path.join(__dirname, 'generated/review-action-v2'),
    path.resolve(__dirname, '../src/control-plane/generated/review-action-v2'),
  ];
  const root = candidates.find((candidate) => existsSync(candidate));
  if (!root) throw new Error('review_action_v2_generated_contract_missing');
  return root;
}

function listRegularFiles(root: string, relative = ''): string[] {
  const directory = path.join(root, ...relative.split('/').filter(Boolean));
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error('review_action_v2_handoff_symlink_forbidden');
    }
    if (entry.isDirectory()) {
      files.push(...listRegularFiles(root, entryRelative));
    } else if (entry.isFile()) {
      files.push(entryRelative);
    } else {
      throw new Error('review_action_v2_handoff_entry_invalid');
    }
  }
  return files.sort();
}

function parseCanonicalObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('review_action_v2_handoff_json_invalid', { cause: error });
  }
  if (!isRecord(value) || canonicalJson(value) !== raw) {
    throw new Error('review_action_v2_handoff_not_canonical');
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error('review_action_v2_handoff_value_invalid');
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error('review_action_v2_handoff_fields_invalid');
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
