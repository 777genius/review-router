import {
  compactCodexAuthJsonBytes,
  deriveCodexStableAccountIdentityFromIdToken,
} from './crypto';

/** The original run deadline is never extended to make refreshed auth fit. */
export const CODEX_AUTH_EXPIRY_MARGIN_MS = 60_000;

type AuthFacts = Readonly<{
  compact: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  identity: string;
  refreshedAt: number;
}>;

export type PreparedCodexCredential = Readonly<{
  accessToken: string;
  accountId: string;
  credentialValidUntil: number;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function authFacts(bytes: string): AuthFacts {
  const compact = compactCodexAuthJsonBytes({
    authJsonBytes: bytes,
  }).compactAuthJsonBytes;
  const parsed = JSON.parse(compact) as Record<string, unknown>;
  const tokens = parsed.tokens;
  if (
    !object(tokens) ||
    typeof tokens.id_token !== 'string' ||
    typeof tokens.access_token !== 'string' ||
    !tokens.access_token ||
    typeof tokens.refresh_token !== 'string' ||
    !tokens.refresh_token
  )
    throw new Error('codex_oauth_refresh_auth_invalid');
  const identity = deriveCodexStableAccountIdentityFromIdToken(tokens.id_token);
  if (
    tokens.account_id !== undefined &&
    tokens.account_id !== identity.chatgptAccountId
  )
    throw new Error('codex_oauth_refresh_account_mismatch');
  return {
    compact,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: identity.chatgptAccountId,
    identity: JSON.stringify(identity),
    refreshedAt:
      typeof parsed.last_refresh === 'string'
        ? Date.parse(parsed.last_refresh)
        : NaN,
  };
}

/** Validate the official helper's confirmed rotation for encrypted writeback.
 * This is not inference admission: even an access token with insufficient
 * remaining lifetime must not cause a new, possibly single-use refresh token
 * to be discarded. The prepared route checks lifetime after definite writeback.
 * Claim inspection is not independent JWT authentication; the pinned official
 * helper obtains the token from the approved OAuth endpoint. */
export function validateCodexRefreshedAuth(input: {
  readonly originalAuthJson: string;
  readonly refreshedAuthJson: string;
  readonly startedAt: number;
  readonly now: number;
  /** Retained for caller compatibility; enforced by the prepared route instead. */
  readonly requiredValidUntil: number;
}): Readonly<{
  authJsonBytes: string;
  credentialValidUntil: number;
  accountId: string;
}> {
  const before = authFacts(input.originalAuthJson);
  const after = authFacts(input.refreshedAuthJson);
  if (before.identity !== after.identity)
    throw new Error('codex_oauth_refresh_account_changed');
  if (
    !Number.isFinite(after.refreshedAt) ||
    after.refreshedAt < input.startedAt - 1_000 ||
    after.refreshedAt > input.now + CODEX_AUTH_EXPIRY_MARGIN_MS ||
    (before.accessToken === after.accessToken &&
      before.refreshToken === after.refreshToken)
  )
    throw new Error('codex_oauth_refresh_not_confirmed');
  const credential = decodedCredentialFromFacts(after);
  return Object.freeze({
    authJsonBytes: after.compact,
    credentialValidUntil: credential.credentialValidUntil,
    accountId: credential.accountId,
  });
}

/** Read only material whose refresh/generation was already approved by its
 * credential adapter. This performs no OAuth call and grants no refresh proof. */
export function readPreparedCodexCredential(
  authJsonBytes: string,
  requiredValidUntil: number
): PreparedCodexCredential {
  const credential = decodedCredentialFromFacts(authFacts(authJsonBytes));
  if (
    !Number.isSafeInteger(requiredValidUntil) ||
    requiredValidUntil < Date.now() ||
    credential.credentialValidUntil <
      requiredValidUntil + CODEX_AUTH_EXPIRY_MARGIN_MS
  )
    throw new Error('codex_oauth_refresh_lifetime_insufficient');
  return credential;
}

function decodedCredentialFromFacts(facts: AuthFacts): PreparedCodexCredential {
  let claims: unknown;
  try {
    const parts = facts.accessToken.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!))
      throw new Error();
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new Error('codex_oauth_refresh_expiry_unavailable');
  }
  if (
    !object(claims) ||
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= 0 ||
    !Number.isSafeInteger(claims.exp * 1_000)
  )
    throw new Error('codex_oauth_refresh_expiry_unavailable');
  return Object.freeze({
    accessToken: facts.accessToken,
    credentialValidUntil: claims.exp * 1_000,
    accountId: facts.accountId,
  });
}

/** Reject malformed input before creating any temporary credential material. */
export function validateCodexRefreshInput(authJson: string): void {
  authFacts(authJson);
}
