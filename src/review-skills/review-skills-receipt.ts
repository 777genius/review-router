import type {
  AcceptedReviewWorkSlotEvidence,
  PreparedReviewInvocationPort,
} from '../review-orchestration/application';
import type { ReviewSkillsGitRootDiagnostic } from './materialize-review-skills';
import {
  reviewSkillMatchesPath,
  type ReviewSkillsExecutionInput,
} from './review-skills';
import { renderReviewSkillsDiagnosticText } from './review-skills-error';

export const REVIEW_SKILLS_RECEIPT_UNAVAILABLE =
  'Review skills receipt unavailable: publication limits.';
export type FreshReviewSkillsSupply = Readonly<{
  providerInvocationKey: string;
  payloadHash: string;
  /** Native prompt paths. OCR cannot prove delivery for each group/path. */
  paths?: readonly string[];
}>;

/** Local witnesses only. Absence never establishes cache reuse or model compliance. */
export class ReviewSkillsReceiptCollector {
  private readonly fresh = new Map<string, FreshReviewSkillsSupply>();
  record(input: FreshReviewSkillsSupply): void {
    this.fresh.set(
      `${input.providerInvocationKey}\0${input.payloadHash}`,
      Object.freeze({
        ...input,
        ...(input.paths ? { paths: Object.freeze([...input.paths]) } : {}),
      })
    );
  }

  render(input: {
    skills: ReviewSkillsExecutionInput;
    changedPaths: readonly string[];
    gitRoots?: readonly ReviewSkillsGitRootDiagnostic[];
    acceptedEvidence: readonly AcceptedReviewWorkSlotEvidence[];
  }): string | undefined {
    if (
      input.skills.kind === 'legacy' ||
      (!input.skills.capture.webSkills.length &&
        !input.skills.capture.gitSources.length)
    )
      return undefined;
    const skills = input.skills;
    const acceptedPaths = new Set(
      input.acceptedEvidence.flatMap((item) =>
        item.coverageManifest.paths
          .filter(
            (path) =>
              path.kind !== 'unavailable' && path.kind !== 'policy_excluded'
          )
          .map((path) => path.path)
      )
    );
    const witnessedByKey = new Map<string, FreshReviewSkillsSupply>();
    for (const { observation } of input.acceptedEvidence) {
      const key = `${observation.providerInvocationKey}\0${observation.payloadHash}`;
      const supply = this.fresh.get(key);
      if (supply) witnessedByKey.set(key, supply);
    }
    const witnessed = [...witnessedByKey.values()];
    const suppliedPaths = new Set(
      witnessed.flatMap((supply) => supply.paths ?? [])
    );
    const statuses = [
      'Instructions supplied with accepted review evidence from this run',
      'Accepted evidence available; fresh instruction supply unconfirmed',
      'Matching paths have no accepted review evidence',
      'No changed paths matched',
    ] as const;
    const changedPaths = [...new Set(input.changedPaths)];
    const status = (skill: (typeof skills.bundle.skills)[number]): number => {
      if (!changedPaths.some((path) => reviewSkillMatchesPath(skill, path)))
        return 3;
      if (
        [...suppliedPaths].some((path) => reviewSkillMatchesPath(skill, path))
      )
        return 0;
      return [...acceptedPaths].some((path) =>
        reviewSkillMatchesPath(skill, path)
      )
        ? 1
        : 2;
    };
    const lines = [
      '<details>',
      '<summary>Review skills</summary>',
      '',
      'This records instruction supply, not whether a model followed or verified a Skill.',
      '',
    ];
    const web = skills.bundle.skills.filter((skill) => skill.origin === 'web');
    if (web.length) {
      const counts = [0, 0, 0, 0];
      for (const skill of web) counts[status(skill)]++;
      lines.push(`Web skills captured: ${web.length}.`);
      statuses.forEach((label, index) => {
        const count = counts[index];
        if (count) lines.push(`- ${label}: ${count}`);
      });
      lines.push('');
    }
    const ocr = witnessed.filter((supply) => supply.paths === undefined).length;
    if (ocr)
      lines.push(
        `Fresh accepted OCR invocations received the controlled Skills rules: ${ocr}. Delivery for individual Skills and paths is unconfirmed.`,
        ''
      );
    const git = skills.bundle.skills.filter((skill) => skill.origin === 'git');
    let omitted = 0;
    for (const skill of git) {
      // Only materializer-issued identities within configured roots are eligible for publication.
      const directory = skill.skillId.startsWith('git:')
        ? skill.skillId.slice(4)
        : '';
      if (
        !skills.capture.gitSources.some(
          ({ root }) =>
            directory.startsWith(`${root}/`) &&
            !directory.slice(root.length + 1).includes('/')
        )
      ) {
        omitted++;
        continue;
      }
      const count = [...acceptedPaths].filter((path) =>
        reviewSkillMatchesPath(skill, path)
      ).length;
      const row = `- ${renderReviewSkillsDiagnosticText(`${directory}/SKILL.md`)} — ${statuses[status(skill)]}; matching paths in accepted scope: ${count}`;
      if (Buffer.byteLength([...lines, row].join('\n')) > 4_000) {
        omitted++;
        continue;
      }
      lines.push(row);
    }
    if (omitted) lines.push(`Repository Skill rows omitted: ${omitted}.`);
    for (const root of input.gitRoots ?? [])
      lines.push(
        `- ${renderReviewSkillsDiagnosticText(root.root)}: ${root.status === 'missing' ? 'root missing at captured base' : root.status === 'empty' ? 'no discoverable SKILL.md files at captured base' : `${root.skillCount} Skills loaded`}`
      );
    lines.push(
      '',
      `Trusted base: ${renderReviewSkillsDiagnosticText(skills.capture.baseSha)}`,
      `Captured identity: ${renderReviewSkillsDiagnosticText(skills.capture.digest)}`,
      `Materialized identity: ${renderReviewSkillsDiagnosticText(skills.bundle.executionDigest)}`,
      '',
      '</details>'
    );
    return lines.join('\n');
  }
}

/** This native port executes a fresh CLI call; preparation and lookup never enter it. */
export function observeNativeReviewSkillsSupply(
  delegate: PreparedReviewInvocationPort,
  collector: ReviewSkillsReceiptCollector,
  requestCount: () => number | undefined
): PreparedReviewInvocationPort {
  return {
    prepare: (input) => delegate.prepare(input),
    execute: async (input) => {
      const before = requestCount();
      const observation = await delegate.execute(input);
      const after = requestCount();
      if (
        observation.schemaValidated &&
        observation.fullyConsumed &&
        typeof before === 'number' &&
        Number.isFinite(before) &&
        before >= 0 &&
        typeof after === 'number' &&
        Number.isFinite(after) &&
        after > before
      )
        collector.record({
          providerInvocationKey: input.manifest.providerInvocationKey,
          payloadHash: observation.payloadHash,
          paths: input.invocation.coverageManifest.paths.map(
            (path) => path.path
          ),
        });
      return observation;
    },
  };
}
