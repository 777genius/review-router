// Shared protocol-compatibility check for workflow channel promotion and monitoring.
// Compares the Action contract triple (protocolVersion + schemaDigest + canonicalizerDigest)
// read from a manifest at an exact commit against the deployed API protocol-info contracts.

const WELL_FORMED_DIGEST = /^[a-f0-9]{64}$/;
const WELL_FORMED_PROTOCOL_VERSION = /^[0-9A-Za-z._-]{1,16}$/;

export const PROTOCOL_COMPAT_FAILURE_REASONS = [
  'protocol_incompatible',
  'protocol_info_unavailable',
  'protocol_info_invalid',
  'action_manifest_invalid',
];

function normalizeContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const protocolVersion =
    typeof value.protocolVersion === 'string' ||
    typeof value.protocolVersion === 'number'
      ? String(value.protocolVersion)
      : '';
  const { schemaDigest, canonicalizerDigest } = value;
  if (!WELL_FORMED_PROTOCOL_VERSION.test(protocolVersion)) return null;
  if (typeof schemaDigest !== 'string' || !WELL_FORMED_DIGEST.test(schemaDigest))
    return null;
  if (
    typeof canonicalizerDigest !== 'string' ||
    !WELL_FORMED_DIGEST.test(canonicalizerDigest)
  ) {
    return null;
  }
  return { protocolVersion, schemaDigest, canonicalizerDigest };
}

export function parseActionManifestContract(manifestSource) {
  let manifest;
  try {
    manifest = JSON.parse(manifestSource);
  } catch {
    return null;
  }
  return normalizeContract(manifest);
}

function parseProtocolInfoContracts(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.infoVersion !== 1 || !Array.isArray(body.contracts)) return null;
  const contracts = [];
  for (const entry of body.contracts) {
    const contract = normalizeContract(entry);
    if (!contract) return null;
    contracts.push(contract);
  }
  return contracts;
}

async function readProtocolInfo(protocolInfoUrl, fetchImpl, timeoutMs) {
  // One retry on a transient network error only; HTTP failures are not retried.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(protocolInfoUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: abort.signal,
      });
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 200) return { kind: 'unavailable' };
    try {
      return { kind: 'ok', body: await response.json() };
    } catch {
      return { kind: 'invalid' };
    }
  }
  return { kind: 'unavailable' };
}

export async function checkWorkflowChannelProtocolCompatibility(input) {
  const {
    manifestSource,
    protocolInfoUrl,
    fetchImpl = fetch,
    timeoutMs = 10000,
  } = input;
  const contract = parseActionManifestContract(manifestSource);
  if (!contract) {
    return { compatible: false, reason: 'action_manifest_invalid' };
  }
  const info = await readProtocolInfo(protocolInfoUrl, fetchImpl, timeoutMs);
  if (info.kind === 'unavailable') {
    return { compatible: false, reason: 'protocol_info_unavailable' };
  }
  if (info.kind === 'invalid') {
    return { compatible: false, reason: 'protocol_info_invalid' };
  }
  const contracts = parseProtocolInfoContracts(info.body);
  if (!contracts) {
    return { compatible: false, reason: 'protocol_info_invalid' };
  }
  const supported = contracts.some(
    (candidate) =>
      candidate.protocolVersion === contract.protocolVersion &&
      candidate.schemaDigest === contract.schemaDigest &&
      candidate.canonicalizerDigest === contract.canonicalizerDigest
  );
  if (!supported) {
    return { compatible: false, reason: 'protocol_incompatible' };
  }
  return { compatible: true, contract };
}
