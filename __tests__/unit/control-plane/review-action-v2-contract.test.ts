import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveReviewActionV2Activation,
  ReviewActionV2RuntimeMode,
  verifyReviewActionV2Handoff,
} from '../../../src/control-plane/review-action-v2-contract';

describe('review Action v2 handoff gate', () => {
  const sourceRoot = path.resolve(
    __dirname,
    '../../../src/control-plane/generated/review-action-v2'
  );
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps v2 disabled without requiring a handoff manifest', () => {
    expect(resolveReviewActionV2Activation({ env: {} })).toEqual({
      mode: ReviewActionV2RuntimeMode.Disabled,
    });
  });

  it('fails closed when t0 is requested without the official handoff', () => {
    const root = copyGeneratedFixture();
    rmSync(path.join(root, 'handoff-manifest.json'));
    expect(() =>
      resolveReviewActionV2Activation({
        env: { REVIEWROUTER_ACTION_V2_MODE: 't0' },
        generatedRoot: root,
      })
    ).toThrow('review_action_v2_handoff_manifest_missing');
  });

  it('verifies every exported byte and rejects later drift', () => {
    const root = copyGeneratedFixture();
    expect(verifyReviewActionV2Handoff(root)).toMatchObject({
      saasSourceCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
      expectedPublicActionBaseCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
      generatedFileCount: expect.any(Number),
    });

    writeFileSync(path.join(root, 'manifest.json'), '{}\n');
    expect(() => verifyReviewActionV2Handoff(root)).toThrow(
      'review_action_v2_handoff_file_digest_mismatch'
    );
  });

  function copyGeneratedFixture(): string {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'rr-action-v2-'));
    const root = path.join(parent, 'generated');
    temporaryRoots.push(parent);
    cpSync(sourceRoot, root, { recursive: true });
    return root;
  }
});
