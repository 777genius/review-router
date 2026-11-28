import { readFileSync } from 'node:fs';
import { ReviewActionV2Client } from '../../../src/control-plane/review-action-v2-client';
import { ReviewActionV2OperationId } from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import { ReviewActionV2ControlPlaneAdapter } from '../../../src/review-orchestration/infrastructure/review-action-v2-control-plane-adapter';

// The compatibility test resolves these three imports to the exact checked-out
// pre-change source. No decoder implementation is copied or patched here.
async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('old_reader_fixture_missing');
  const bytes = readFileSync(file, 'utf8');
  if (Buffer.byteLength(bytes) > 65_536)
    throw new Error('old_reader_fixture_too_large');
  const value: unknown = JSON.parse(bytes);
  if (
    !value ||
    typeof value !== 'object' ||
    !('authorization' in value) ||
    !('restore' in value) ||
    !('reviewRevisionHash' in value) ||
    typeof value.reviewRevisionHash !== 'string'
  )
    throw new Error('old_reader_fixture_invalid');
  const client = new ReviewActionV2Client({
    apiUrl: 'https://old-reader.invalid',
    fetchImpl: async () => {
      throw new Error('old_reader_network_forbidden');
    },
  });
  Object.defineProperty(client, 'execute', {
    value: async (operation: ReviewActionV2OperationId): Promise<unknown> => {
      if (operation === ReviewActionV2OperationId.ReviewRunAuthorize)
        return value.authorization;
      if (operation === ReviewActionV2OperationId.ReviewExecutionRestore)
        return value.restore;
      throw new Error('old_reader_operation_forbidden');
    },
  });
  const adapter = new ReviewActionV2ControlPlaneAdapter(client);
  const authorization = await adapter.authorize({ oidcToken: 'fixture-only' });
  const restored = await adapter.restoreExecution({
    authorization,
    reviewRevisionHash: value.reviewRevisionHash,
  });
  process.stdout.write(JSON.stringify({ restored }));
}

void main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[a-z0-9_]{1,120}$/.test(error.message)
      ? error.message
      : 'old_reader_failed';
  process.stderr.write(code);
  process.exitCode = 1;
});
