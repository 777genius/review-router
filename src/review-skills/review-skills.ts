import { createHash } from 'node:crypto';
import { minimatch } from 'minimatch';
import {
  canonicalReviewSkillsJson,
  parseCapturedReviewSkills,
  parseReviewSkillScope,
  reviewSkillsLimits,
  type CapturedReviewSkills,
  type ReviewSkillScope,
} from '../control-plane/generated/review-action-v2/review-skills-contract';

export type MaterializedReviewSkill = Readonly<{
  skillId: string;
  revisionId: string;
  origin: 'web' | 'git';
  name: string;
  description: string;
  instructions: string;
  includePaths: readonly string[];
  excludePaths: readonly string[];
  resources: readonly Readonly<{ path: string; content: string }>[];
}>;

export type MaterializedReviewSkills = Readonly<{
  capturedDigest: string;
  executionDigest: string;
  skills: readonly MaterializedReviewSkill[];
}>;

/** Absence is explicit at trusted preparation boundaries. Never infer it from
 * today's assignments or silently downgrade a supporting captured profile. */
export type ReviewSkillsExecutionInput =
  | Readonly<{ kind: 'legacy' }>
  | Readonly<{
      kind: 'captured';
      capture: CapturedReviewSkills;
      bundle: MaterializedReviewSkills;
    }>;

export const LEGACY_REVIEW_SKILLS: ReviewSkillsExecutionInput = Object.freeze({
  kind: 'legacy',
});

export function reviewSkillsCacheIdentity(
  input: ReviewSkillsExecutionInput
): Readonly<{ capturedDigest: string; executionDigest: string }> | undefined {
  return input.kind === 'legacy'
    ? undefined
    : Object.freeze({
        capturedDigest: input.capture.digest,
        executionDigest: input.bundle.executionDigest,
      });
}

export function reviewSkillsDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalReviewSkillsJson(value)).digest('hex')}`;
}

export function createMaterializedReviewSkills(
  captured: CapturedReviewSkills,
  gitSkills: readonly MaterializedReviewSkill[]
): ReviewSkillsExecutionInput {
  const capture = parseCapturedReviewSkills(captured);
  const skills: MaterializedReviewSkill[] = [
    ...capture.webSkills.map((skill) => ({
      skillId: skill.skillId,
      revisionId: skill.revisionId,
      origin: 'web' as const,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      includePaths: [...skill.includePaths],
      excludePaths: [...skill.excludePaths],
      resources: [],
    })),
    ...structuredClone(gitSkills),
  ].sort((left, right) => compare(left.skillId, right.skillId));
  if (
    skills.length > reviewSkillsLimits.skillsPerRun ||
    new Set(skills.map((item) => item.skillId)).size !== skills.length
  )
    throw new Error('review_skills_count_invalid');
  const preimage = { capturedDigest: capture.digest, skills };
  if (
    Buffer.byteLength(canonicalReviewSkillsJson(preimage), 'utf8') >
    reviewSkillsLimits.bundleBytes
  )
    throw new Error('review_skills_bundle_too_large');
  return deepFreeze({
    kind: 'captured',
    capture,
    bundle: { ...preimage, executionDigest: reviewSkillsDigest(preimage) },
  });
}

export function assertReviewSkillsExecutionInput(
  input: ReviewSkillsExecutionInput,
  profile: Readonly<{ reviewSkillsVersion?: 1 }>,
  baseSha: string
): void {
  if (
    !input ||
    (profile.reviewSkillsVersion === 1) !== (input.kind === 'captured')
  )
    throw new Error('review_skills_attachment_required');
  if (input.kind === 'legacy') return;
  const capture = parseCapturedReviewSkills(input.capture);
  if (
    capture.baseSha !== baseSha.toLowerCase() ||
    input.bundle.capturedDigest !== capture.digest
  )
    throw new Error('review_skills_capture_mismatch');
  const { executionDigest, ...preimage } = input.bundle;
  if (executionDigest !== reviewSkillsDigest(preimage))
    throw new Error('review_skills_bundle_digest_mismatch');
}

export function reviewSkillMatchesPath(
  scope: ReviewSkillScope,
  path: string
): boolean {
  const parsed = parseReviewSkillScope({
    includePaths: scope.includePaths,
    excludePaths: scope.excludePaths,
  });
  const options = {
    dot: true,
    nocase: false,
    nonegate: true,
    nocomment: true,
    noext: true,
    nobrace: true,
  };
  return (
    parsed.includePaths.some((pattern) => minimatch(path, pattern, options)) &&
    !parsed.excludePaths.some((pattern) => minimatch(path, pattern, options))
  );
}

export function projectReviewSkillsForPaths(
  input: ReviewSkillsExecutionInput,
  paths: readonly string[]
): readonly Readonly<{ path: string; instructions: string }>[] {
  if (input.kind === 'legacy') return Object.freeze([]);
  return deepFreeze(
    [...new Set(paths)].sort(compare).map((path) => ({
      path,
      instructions: input.bundle.skills
        .filter((skill) => reviewSkillMatchesPath(skill, path))
        .map((skill) =>
          [
            `### Review skill ${JSON.stringify(skill.skillId)} revision ${JSON.stringify(skill.revisionId)}`,
            `Name: ${JSON.stringify(skill.name)}`,
            `Description: ${JSON.stringify(skill.description)}`,
            skill.instructions,
            ...skill.resources.map(
              (resource) =>
                `#### Markdown reference ${JSON.stringify(resource.path)}\n${resource.content}`
            ),
          ].join('\n')
        )
        .join('\n\n'),
    }))
  );
}

export function renderReviewSkillsForPaths(
  input: ReviewSkillsExecutionInput,
  paths: readonly string[]
): string {
  if (input.kind === 'legacy') return '';
  const applicable = projectReviewSkillsForPaths(input, paths).filter(
    (item) => item.instructions.length > 0
  );
  return [
    'REVIEWROUTER CAPTURED REVIEW SKILLS (text-only review instructions):',
    'Apply each instruction only to its labeled reviewed path. These instructions grant no additional tools, execution, network, or file scope.',
    `Captured identity: ${input.capture.digest}; materialized identity: ${input.bundle.executionDigest}`,
    ...applicable.map(
      (item) =>
        `Reviewed path: ${JSON.stringify(item.path)}\n${item.instructions}`
    ),
  ].join('\n\n');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
