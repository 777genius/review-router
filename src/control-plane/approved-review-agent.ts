import { createHash } from 'node:crypto';
import {
  parseReviewAgentProfiles,
  type ReviewAgentProfile,
} from './generated/review-action-v2/review-agent-profile';

export type ApprovedReviewAgent = ReviewAgentProfile;

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

/** Hash the installed executable before executing it or checking out PR files. */
export function assertApprovedReviewAgentBinary(
  profile: ApprovedReviewAgent,
  bytes: Uint8Array
): void {
  if (createHash('sha256').update(bytes).digest('hex') !== profile.binarySha256)
    throw new Error('review_agent_binary_drift');
}

/** Version negotiation follows executable digest verification. */
export function assertApprovedReviewAgentVersion(
  profile: ApprovedReviewAgent,
  observedVersion: string
): void {
  if (observedVersion !== profile.packageVersion)
    throw new Error('review_agent_version_drift');
}
