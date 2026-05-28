import { createHash, createHmac, randomUUID } from 'crypto';
import sodium from 'libsodium-wrappers';

export const CODEX_ROTATING_SECRET_NAME = 'REVIEWROUTER_CODEX_AUTH_JSON';
export const CODEX_ROTATING_AUTH_JSON_MAX_BYTES = 32 * 1024;

export type CompactCodexAuthJsonResult = {
  compactAuthJsonBytes: string;
  byteLength: number;
  exactBytesSha256: string;
};

export type CodexRotatingEncryptedWriteback = {
  compactAuthJsonBytes: string;
  compactByteLength: number;
  latestGenerationHash: string;
  encryptedValue: string;
  keyId: string;
};

export function compactCodexAuthJsonBytes(input: {
  authJsonBytes: string;
}): CompactCodexAuthJsonResult {
  const byteLength = Buffer.byteLength(input.authJsonBytes, 'utf8');
  if (byteLength === 0) {
    throw new Error('codex_auth_json_empty');
  }
  if (byteLength > CODEX_ROTATING_AUTH_JSON_MAX_BYTES) {
    throw new Error('codex_auth_json_too_large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.authJsonBytes);
  } catch {
    throw new Error('codex_auth_json_invalid_json');
  }

  assertCodexChatGptAuth(parsed);
  const compactAuthJsonBytes = JSON.stringify(parsed);
  const compactByteLength = Buffer.byteLength(compactAuthJsonBytes, 'utf8');
  if (compactByteLength > CODEX_ROTATING_AUTH_JSON_MAX_BYTES) {
    throw new Error('codex_auth_json_too_large_after_compact');
  }

  return {
    compactAuthJsonBytes,
    byteLength: compactByteLength,
    exactBytesSha256: createHash('sha256')
      .update(input.authJsonBytes, 'utf8')
      .digest('hex'),
  };
}

export function computeCodexAuthGenerationHash(input: {
  authJsonBytes: string;
  generationHashSalt: string;
}): string {
  const salt = decodeSalt(input.generationHashSalt);
  if (salt.length < 16) {
    throw new Error('generation_hash_salt_too_short');
  }
  return createHmac('sha256', salt)
    .update(input.authJsonBytes, 'utf8')
    .digest('base64url');
}

export async function encryptCodexAuthForGitHubSecret(input: {
  authJsonBytes: string;
  githubPublicKeyBase64: string;
  githubKeyId: string;
  generationHashSalt: string;
}): Promise<CodexRotatingEncryptedWriteback> {
  const compact = compactCodexAuthJsonBytes({
    authJsonBytes: input.authJsonBytes,
  });
  await sodium.ready;
  const publicKey = Buffer.from(input.githubPublicKeyBase64, 'base64');
  if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error('github_secret_public_key_invalid');
  }

  const encrypted = sodium.crypto_box_seal(
    compact.compactAuthJsonBytes,
    publicKey
  );
  return {
    compactAuthJsonBytes: compact.compactAuthJsonBytes,
    compactByteLength: compact.byteLength,
    latestGenerationHash: computeCodexAuthGenerationHash({
      authJsonBytes: compact.compactAuthJsonBytes,
      generationHashSalt: input.generationHashSalt,
    }),
    encryptedValue: Buffer.from(encrypted).toString('base64'),
    keyId: input.githubKeyId,
  };
}

export function buildCodexRotatingWritebackRequest(input: {
  leaseId: string;
  providerInstanceId: string;
  generation: number;
  latestGenerationHash: string;
  encryptedValue: string;
  keyId: string;
  idempotencyKey?: string;
}) {
  if (looksLikePlaintextAuthJson(input.encryptedValue)) {
    throw new Error('writeback_plaintext_auth_rejected');
  }
  return {
    protocolVersion: 1 as const,
    leaseId: input.leaseId,
    providerInstanceId: input.providerInstanceId,
    generation: input.generation,
    latestGenerationHash: input.latestGenerationHash,
    encryptedValue: input.encryptedValue,
    keyId: input.keyId,
    idempotencyKey: input.idempotencyKey ?? `wrb:${randomUUID()}`,
  };
}

function assertCodexChatGptAuth(value: unknown): asserts value is {
  auth_mode: 'chatgpt';
  tokens: { refresh_token: string };
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('codex_auth_json_invalid_shape');
  }
  const record = value as {
    auth_mode?: unknown;
    tokens?: { refresh_token?: unknown };
  };
  if (record.auth_mode !== 'chatgpt') {
    throw new Error('codex_auth_json_auth_mode_not_chatgpt');
  }
  if (
    !record.tokens ||
    typeof record.tokens.refresh_token !== 'string' ||
    record.tokens.refresh_token.length === 0
  ) {
    throw new Error('codex_auth_json_refresh_token_missing');
  }
}

function decodeSalt(value: string): Buffer {
  if (!/^[A-Za-z0-9_+/=-]+$/.test(value)) {
    throw new Error('generation_hash_salt_invalid');
  }
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return Buffer.from(value, 'base64');
  }
}

function looksLikePlaintextAuthJson(value: string): boolean {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.includes('"auth_mode"') || decoded.includes('refresh_token');
  } catch {
    return value.includes('"auth_mode"') || value.includes('refresh_token');
  }
}
