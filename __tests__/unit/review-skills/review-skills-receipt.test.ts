import {
  ReviewSkillsReceiptCollector,
  observeNativeReviewSkillsSupply,
} from '../../../src/review-skills/review-skills-receipt';
import { createCapturedReviewSkills } from '../../../src/control-plane/generated/review-action-v2/review-skills-contract';
import {
  createMaterializedReviewSkills,
  LEGACY_REVIEW_SKILLS,
} from '../../../src/review-skills/review-skills';
import type {
  AcceptedReviewWorkSlotEvidence,
  PreparedReviewInvocationPort,
} from '../../../src/review-orchestration/application';

const skills = createMaterializedReviewSkills(
  createCapturedReviewSkills({
    baseSha: 'a'.repeat(40),
    gitSources: [],
    webSkills: [
      {
        skillId: 'PRIVATE_ID',
        revisionId: 'PRIVATE_REVISION',
        sourceWorkspaceId: 'PRIVATE_WORKSPACE',
        name: 'PRIVATE_NAME',
        description: 'PRIVATE_DESCRIPTION',
        instructions: 'PRIVATE_BODY',
        includePaths: ['src/**'],
        excludePaths: [],
      },
      {
        skillId: 'OTHER_PRIVATE_ID',
        revisionId: 'PRIVATE_REVISION',
        sourceWorkspaceId: 'PRIVATE_WORKSPACE',
        name: 'PRIVATE_NAME',
        description: '',
        instructions: 'PRIVATE_BODY',
        includePaths: ['other/**'],
        excludePaths: [],
      },
    ],
  }),
  []
);
const evidence: AcceptedReviewWorkSlotEvidence = {
  workSlotId: 'slot',
  observation: {
    observationId: 'observation',
    eligibilityPolicyVersion: 'fixture',
    providerKind:
      'codex' as import('../../../src/review-orchestration/application').ReviewExecutionProviderKind,
    providerVoteIdentityHash: 'vote',
    payloadCanonicalJson: '{}',
    byteCount: 2,
    findingCount: 0,
    actualModel: 'fixture',
    qualityFlags: [],
    transportAttemptCount: 1,
    providerInvocationKey: 'key',
    payloadHash: 'payload',
    schemaValidated: true,
    fullyConsumed: true,
  },
  coverageManifest: {
    version: 'review_prompt_coverage.v2',
    workSlotId: 'slot',
    reviewRevisionHash: 'a'.repeat(64),
    coverageHash: 'b'.repeat(64),
    paths: [
      {
        path: 'src/a.ts',
        kind: 'summary_only' as import('../../../src/analysis/llm/prepared-review-prompt').PreparedPromptPathCoverageKind,
        contentHash: null,
      },
    ],
  },
};
const render = (
  collector: ReviewSkillsReceiptCollector,
  acceptedEvidence = [evidence]
) =>
  collector.render({ skills, changedPaths: ['src/a.ts'], acceptedEvidence })!;

describe('review Skills receipt truthfulness and privacy', () => {
  it('keeps absent, captured-empty and unconfirmed evidence distinct without inferring reuse', () => {
    const collector = new ReviewSkillsReceiptCollector();
    expect(
      collector.render({
        skills: LEGACY_REVIEW_SKILLS,
        changedPaths: [],
        acceptedEvidence: [],
      })
    ).toBeUndefined();
    expect(
      collector.render({
        skills: createMaterializedReviewSkills(
          createCapturedReviewSkills({
            baseSha: 'a'.repeat(40),
            webSkills: [],
            gitSources: [],
          }),
          []
        ),
        changedPaths: [],
        acceptedEvidence: [],
      })
    ).toBeUndefined();
    expect(render(collector)).toContain(
      'fresh instruction supply unconfirmed: 1'
    );
    expect(render(collector)).not.toContain('reused');
    expect(render(collector, [])).toContain(
      'Matching paths have no accepted review evidence: 1'
    );
    expect(render(collector)).toContain('No changed paths matched: 1');
  });
  it('intersects fresh payload and invocation witnesses with accepted evidence, independently of full coverage', () => {
    const collector = new ReviewSkillsReceiptCollector();
    collector.record({
      providerInvocationKey: 'key',
      payloadHash: 'wrong',
      paths: ['src/a.ts'],
    });
    collector.record({
      providerInvocationKey: 'wrong',
      payloadHash: 'payload',
      paths: ['src/a.ts'],
    });
    expect(render(collector)).not.toContain(
      'Instructions supplied with accepted review evidence from this run:'
    );
    collector.record({
      providerInvocationKey: 'key',
      payloadHash: 'payload',
      paths: ['src/a.ts'],
    });
    const receipt = render(collector);
    expect(receipt).toContain(
      'Instructions supplied with accepted review evidence from this run: 1'
    );
    expect(render(collector, [])).not.toContain(
      'Instructions supplied with accepted review evidence from this run:'
    );
    expect(receipt).toContain('Captured identity:');
    expect(receipt).toContain('Materialized identity:');
    expect(receipt).not.toMatch(
      /PRIVATE_(?:ID|REVISION|WORKSPACE|NAME|DESCRIPTION|BODY)/
    );
  });
  it('reports only aggregate OCR supply and leaves individual Skill delivery unconfirmed', () => {
    const collector = new ReviewSkillsReceiptCollector();
    collector.record({ providerInvocationKey: 'key', payloadHash: 'payload' });
    expect(render(collector)).toContain(
      'Fresh accepted OCR invocations received the controlled Skills rules: 1'
    );
    expect(render(collector, [evidence, evidence])).toContain(
      'Fresh accepted OCR invocations received the controlled Skills rules: 1'
    );
    expect(render(collector)).toContain(
      'Delivery for individual Skills and paths is unconfirmed'
    );
    expect(render(collector)).not.toContain(
      'Instructions supplied with accepted review evidence from this run:'
    );
    const unavailable = {
      ...evidence,
      coverageManifest: {
        ...evidence.coverageManifest,
        paths: [
          {
            ...evidence.coverageManifest.paths[0],
            kind: 'unavailable' as import('../../../src/analysis/llm/prepared-review-prompt').PreparedPromptPathCoverageKind,
          },
        ],
      },
    };
    expect(render(collector, [unavailable])).toContain(
      'Matching paths have no accepted review evidence: 1'
    );
  });
  it('records native supply only after successful execute, never preparation or failure', async () => {
    const collector = new ReviewSkillsReceiptCollector();
    const invocation = { coverageManifest: evidence.coverageManifest } as never;
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValue(evidence.observation);
    let requests = 0;
    const delegate = {
      prepare: jest.fn().mockResolvedValue(invocation),
      execute: async (input) => {
        const result = await execute(input);
        requests++;
        return result;
      },
    } as PreparedReviewInvocationPort;
    const observed = observeNativeReviewSkillsSupply(
      delegate,
      collector,
      () => requests
    );
    await observed.prepare({} as never);
    expect(render(collector)).toContain('fresh instruction supply unconfirmed');
    const input = {
      invocation,
      manifest: { providerInvocationKey: 'key' },
    } as never;
    await expect(observed.execute(input)).rejects.toThrow('failed');
    expect(render(collector)).toContain('fresh instruction supply unconfirmed');
    await observed.execute(input);
    expect(render(collector)).toContain(
      'Instructions supplied with accepted review evidence from this run: 1'
    );
  });
  it.each([
    { before: undefined, after: 1 },
    { before: 9, after: 9 },
    { before: Number.NaN, after: 1 },
  ])(
    'leaves native supply unconfirmed without a fresh request delta: $before → $after',
    async ({ before, after }) => {
      const collector = new ReviewSkillsReceiptCollector();
      let requests = before;
      const delegate: PreparedReviewInvocationPort = {
        prepare: jest.fn(),
        execute: async () => {
          requests = after;
          return evidence.observation;
        },
      };
      const observed = observeNativeReviewSkillsSupply(
        delegate,
        collector,
        () => requests
      );
      await observed.execute({
        invocation: { coverageManifest: evidence.coverageManifest },
        manifest: { providerInvocationKey: 'key' },
      } as never);
      expect(render(collector)).toContain(
        'fresh instruction supply unconfirmed'
      );
      expect(render(collector)).not.toContain(
        'Instructions supplied with accepted review evidence from this run:'
      );
    }
  );
  it('escapes repository paths, reports roots and bounds repository rows', () => {
    const capture = createCapturedReviewSkills({
      baseSha: 'a'.repeat(40),
      webSkills: [],
      gitSources: [{ root: '.agents/skills' }],
    });
    const git = Array.from({ length: 32 }, (_, index) => ({
      skillId: `git:.agents/skills/${index}[x](url)|<b>@team`,
      revisionId: capture.baseSha,
      origin: 'git' as const,
      name: 'never displayed',
      description: 'never displayed',
      instructions: 'never displayed',
      includePaths: ['**'],
      excludePaths: [],
      resources: [],
    }));
    const receipt = new ReviewSkillsReceiptCollector().render({
      skills: createMaterializedReviewSkills(capture, git),
      changedPaths: ['src/a.ts'],
      acceptedEvidence: [evidence],
      gitRoots: [{ root: '.agents/skills', status: 'loaded', skillCount: 32 }],
    })!;
    expect(receipt).not.toContain('<b>');
    expect(receipt).not.toContain('@team');
    expect(receipt).not.toContain('[x](url)');
    expect(receipt).toContain('rows omitted:');
    expect(receipt).toContain('32 Skills loaded');
    expect(Buffer.byteLength(receipt)).toBeLessThan(5_000);
  });
});
