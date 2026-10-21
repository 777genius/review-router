import { dirname } from 'path';
import { withUsageArtifactUploadTimeout } from './delivery';

/** App-owned replay consumes this exact signed JSON, never logs or credentials. */
export async function uploadUsageArtifact(
  name: string,
  file: string
): Promise<void> {
  const { DefaultArtifactClient } = await import('@actions/artifact');
  const result = await withUsageArtifactUploadTimeout(() =>
    new DefaultArtifactClient().uploadArtifact(name, [file], dirname(file), {
      retentionDays: 7,
    })
  );
  if (!result.id) throw new Error('usage_artifact_unavailable');
}
