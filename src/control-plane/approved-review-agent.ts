import { createHash } from 'node:crypto';
import bundledProfiles from './review-agent-profiles.json';
import {
  parseReviewAgentProfiles,
  type ReviewAgentProfile,
} from './generated/review-action-v2/review-agent-profile';

export type ApprovedReviewAgent = ReviewAgentProfile;

/** Secret-backed T0 installs the qualified binary before reading OAuth input. */
export function bundledReviewAgentForTransport(
  transport: ReviewAgentProfile['modelTransports'][number]
): ApprovedReviewAgent {
  const profiles = parseReviewAgentProfiles(bundledProfiles).filter(
    (profile) =>
      profile.agentKind === 'codex' &&
      profile.modelTransports.includes(transport)
  );
  const supporting = profiles.filter(
    (profile) => profile.reviewSkillsVersion === 1
  );
  const candidates = supporting.length > 0 ? supporting : profiles;
  if (candidates.length !== 1)
    throw new Error('review_agent_profile_unavailable');
  return candidates[0]!;
}

/** Called only with runtimeEnv from the authenticated admitted checkout reply. */
export function readApprovedReviewAgent(
  json: string,
  digest: string
): ApprovedReviewAgent {
  if (
    Buffer.byteLength(json) > 16384 ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    createHash('sha256').update(json).digest('hex') !== digest
  )
    throw new Error('review_agent_profile_digest_mismatch');
  const profile = parseReviewAgentProfiles([JSON.parse(json)])[0];
  if (!profile) throw new Error('review_agent_profile_invalid');
  return profile;
}

/** Digest/version checks only need the installed identity; the managed OCR
 * bootstrap verifies its approved profile against the same drift contract. */
export type ApprovedAgentBinaryIdentity = Readonly<{
  binarySha256: string;
  packageVersion: string;
}>;

/** Hash the installed executable before executing it or checking out PR files. */
export function assertApprovedReviewAgentBinary(
  profile: ApprovedAgentBinaryIdentity,
  bytes: Uint8Array
): void {
  if (createHash('sha256').update(bytes).digest('hex') !== profile.binarySha256)
    throw new Error('review_agent_binary_drift');
}

/** Version negotiation follows executable digest verification. */
export function assertApprovedReviewAgentVersion(
  profile: ApprovedAgentBinaryIdentity,
  observedVersion: string
): void {
  if (observedVersion !== profile.packageVersion)
    throw new Error('review_agent_version_drift');
}
