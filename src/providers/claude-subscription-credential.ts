/** The existing setup-token secret is opaque and carries no trustworthy expiry.
 * Only a qualified credential adapter may provide a proven expiry receipt. */
export type ClaudeSubscriptionCredentialLifetime =
  | Readonly<{ kind: 'proven_expiry'; credentialValidUntil: number }>
  | Readonly<{ kind: 'opaque_provider_validated' }>;

export function isClaudeSubscriptionSetupToken(value: string): boolean {
  return value.length <= 16_384 && /^sk-ant-oat01-[A-Za-z0-9._-]+$/.test(value);
}
