import { createHash } from 'node:crypto';

const profileJson = JSON.stringify({
  profileRef: 'qualified-test',
  agentKind: 'codex',
  binarySha256: 'a'.repeat(64),
  packageVersion: '0.147.0',
  modelTransports: ['account_gateway'],
  contextGateway: true,
  cancellation: true,
});
export const approvedAgentRuntimeEnv = {
  REVIEW_ROUTER_AGENT_PROFILE_JSON: profileJson,
  REVIEW_ROUTER_AGENT_PROFILE_DIGEST: createHash('sha256')
    .update(profileJson)
    .digest('hex'),
};
