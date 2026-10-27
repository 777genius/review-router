import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  freezeReviewMemorySnapshot,
  parseReviewMemoryBundle,
  type ReviewMemoryBundle,
} from '../../../src/control-plane/review-memory-v2';

describe('paired Action/API companion v2 golden contract', () => {
  it('preserves exact rendered UTF-8 bytes, hash preimage and snapshot hash for every knowledge kind', () => {
    const bytes = readFileSync(
      resolve(__dirname, '../../fixtures/review-memory-v2.golden.v1.json')
    );
    const fixture = JSON.parse(bytes.toString('utf8')) as {
      fixtureVersion: string;
      bundle: ReviewMemoryBundle;
      renderedPrompt: string;
      hashPreimage: string;
      snapshotHash: string;
    };
    expect(fixture.fixtureVersion).toBe('review-memory-v2-golden/v1');
    const snapshot = freezeReviewMemorySnapshot(
      parseReviewMemoryBundle(fixture.bundle, fixture.bundle)
    );
    expect(snapshot.renderedPrompt).toBe(fixture.renderedPrompt);
    expect(snapshot.hashPreimage).toBe(fixture.hashPreimage);
    expect(snapshot.hash).toBe(fixture.snapshotHash);
    expect(
      createHash('sha256')
        .update(Buffer.from(snapshot.hashPreimage, 'utf8'))
        .digest('hex')
    ).toBe(fixture.snapshotHash);
    expect(
      snapshot.bundle.items.map((item) => [item.kind, item.temporalStatus])
    ).toEqual([
      ['rule', undefined],
      ['exception', undefined],
      ['observation', 'historical'],
      ['observation', 'at_commit'],
    ]);
    expect(snapshot.renderedPrompt).toContain('日本語 and 🚦');
  });
});
