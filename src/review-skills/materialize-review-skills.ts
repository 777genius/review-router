import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { JSON_SCHEMA, load } from 'js-yaml';
import {
  reviewSkillsLimits,
  type CapturedReviewSkills,
} from '../control-plane/generated/review-action-v2/review-skills-contract';
import {
  createMaterializedReviewSkills,
  type MaterializedReviewSkill,
  type ReviewSkillsExecutionInput,
} from './review-skills';
import {
  attributeReviewSkillsError,
  ReviewSkillsMaterializationError,
  type ReviewSkillsErrorContext,
  type ReviewSkillsErrorCode,
} from './review-skills-error';

export type ReviewSkillsGitRootDiagnostic = Readonly<{
  root: CapturedReviewSkills['gitSources'][number]['root'];
  status: 'missing' | 'empty' | 'loaded';
  skillCount: number;
}>;

type TreeEntry = Readonly<{
  mode: string;
  type: string;
  oid: string;
  name: string;
}>;
type TreeBudget = {
  root: string;
  bytes: number;
  entries: number;
  paths: Set<string>;
};
const run = promisify(execFile);
const TREE_BYTES = reviewSkillsLimits.treeBytes;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** All reads use object IDs reached from the captured trusted commit. No
 * checkout paths, filesystem symlinks, hooks, scripts, or remote references. */
export async function materializeReviewSkills(input: {
  capture: CapturedReviewSkills;
  baseSha: string;
  checkoutRoot: string;
  signal?: AbortSignal;
}): Promise<ReviewSkillsExecutionInput> {
  return (await materializeReviewSkillsWithDiagnostics(input)).executionInput;
}

export async function materializeReviewSkillsWithDiagnostics(input: {
  capture: CapturedReviewSkills;
  baseSha: string;
  checkoutRoot: string;
  signal?: AbortSignal;
}): Promise<
  Readonly<{
    executionInput: ReviewSkillsExecutionInput;
    gitRoots: readonly ReviewSkillsGitRootDiagnostic[];
  }>
> {
  const fail: (
    code: ReviewSkillsErrorCode,
    context?: ReviewSkillsErrorContext
  ) => never = (code, context = {}) => {
    throw new ReviewSkillsMaterializationError(code, {
      baseSha: input.baseSha,
      ...context,
    });
  };
  const decode = (bytes: Buffer, context: ReviewSkillsErrorContext): string => {
    try {
      return decoder.decode(bytes);
    } catch {
      return fail('review_skills_git_text_invalid', context);
    }
  };
  const gitRoots: ReviewSkillsGitRootDiagnostic[] = [];
  const capture = structuredClone(input.capture);
  if (
    !/^[a-f0-9]{40}$/.test(input.baseSha) ||
    capture.baseSha !== input.baseSha
  )
    fail('review_skills_capture_mismatch');
  const trees = new Map<
    string,
    Readonly<{ entries: readonly TreeEntry[]; bytes: number }>
  >();
  const charge = (
    bytes: number,
    entries: number,
    path: string,
    budget?: TreeBudget
  ) => {
    if (
      !budget ||
      !(path === budget.root || path.startsWith(`${budget.root}/`)) ||
      budget.paths.has(path)
    )
      return;
    if (
      budget.bytes + bytes > TREE_BYTES ||
      budget.entries + entries > reviewSkillsLimits.treeEntries
    )
      fail('review_skills_git_tree_too_large', { path, field: 'root' });
    budget.bytes += bytes;
    budget.entries += entries;
    budget.paths.add(path);
  };
  const git = async (
    args: readonly string[],
    maxBuffer: number,
    path: string
  ): Promise<Buffer> => {
    input.signal?.throwIfAborted();
    try {
      const result = await run(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-C', input.checkoutRoot, ...args],
        {
          encoding: 'buffer',
          maxBuffer,
          timeout: 30_000,
          signal: input.signal,
          killSignal: 'SIGKILL',
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_NO_REPLACE_OBJECTS: '1',
          },
        }
      );
      return result.stdout;
    } catch {
      input.signal?.throwIfAborted();
      fail('review_skills_git_read_failed', { path });
    }
  };
  const tree = async (
    oid: string,
    path: string,
    budget?: TreeBudget
  ): Promise<readonly TreeEntry[]> => {
    const previous = trees.get(oid);
    if (previous) {
      // Charge each directory path once per root, including cached object aliases.
      charge(previous.bytes, previous.entries.length, path, budget);
      return previous.entries;
    }
    const bytes = await git(['ls-tree', '-z', oid], TREE_BYTES, path);
    let count = 0;
    for (const byte of bytes) if (byte === 0) count++;
    if (count > reviewSkillsLimits.treeEntries)
      fail('review_skills_git_tree_too_large', { path, field: 'root' });
    // Debit the aggregate before decoding or retaining this directory's objects.
    charge(bytes.byteLength, count, path, budget);
    const entries = decode(bytes, { path, field: 'root' })
      .split('\0')
      .filter(Boolean)
      .map((row) => {
        const matched =
          /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([^\0]+)$/u.exec(row);
        if (
          !matched ||
          [...matched[4]].some(
            (character) =>
              character.charCodeAt(0) < 32 ||
              character.charCodeAt(0) === 127 ||
              character === '/' ||
              character === '\\'
          )
        )
          fail('review_skills_git_path_invalid', { path, field: 'root' });
        return {
          mode: matched[1],
          type: matched[2],
          oid: matched[3],
          name: matched[4],
        };
      });
    if (entries.length > reviewSkillsLimits.treeEntries)
      fail('review_skills_git_tree_too_large', { path, field: 'root' });
    trees.set(oid, { entries, bytes: bytes.byteLength });
    return entries;
  };
  const find = async (
    path: string,
    budget?: TreeBudget
  ): Promise<TreeEntry | null> => {
    let oid = input.baseSha;
    let directory = '';
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entry = (await tree(oid, directory, budget)).find(
        (item) => item.name === parts[i]
      );
      if (!entry) return null;
      if (i === parts.length - 1) return entry;
      if (entry.mode !== '040000' || entry.type !== 'tree')
        fail('review_skills_git_nonregular', { path });
      oid = entry.oid;
      directory = directory ? `${directory}/${parts[i]}` : parts[i];
    }
    return null;
  };
  const read = async (
    path: string,
    limit: number,
    budget: TreeBudget
  ): Promise<string> => {
    const entry = await find(path, budget);
    if (!entry)
      fail('review_skills_reference_missing', { path, field: 'reference' });
    if (!/^100(?:644|755)$/.test(entry.mode) || entry.type !== 'blob')
      fail('review_skills_git_nonregular', { path });
    const size = Number(
      decode(await git(['cat-file', '-s', entry.oid], 128, path), {
        path,
      }).trim()
    );
    if (!Number.isSafeInteger(size) || size > limit)
      fail('review_skills_git_blob_too_large', { path });
    const content = decode(
      await git(['cat-file', 'blob', entry.oid], limit + 1, path),
      { path }
    );
    if (content.includes('\0'))
      fail('review_skills_git_text_invalid', { path });
    return content;
  };
  const sources: { path: string; directory: string; budget: TreeBudget }[] = [];
  for (const source of capture.gitSources) {
    if (
      source.root !== '.reviewrouter/skills' &&
      source.root !== '.agents/skills'
    )
      fail('review_skills_git_root_invalid', { field: 'root' });
    const budget: TreeBudget = {
      root: source.root,
      bytes: 0,
      entries: 0,
      paths: new Set(),
    };
    const root = await find(source.root, budget);
    if (!root) {
      gitRoots.push({ root: source.root, status: 'missing', skillCount: 0 });
      continue;
    }
    if (root.mode !== '040000' || root.type !== 'tree')
      fail('review_skills_git_nonregular', {
        path: source.root,
        field: 'root',
      });
    const before = sources.length;
    for (const child of await tree(root.oid, source.root, budget)) {
      if (child.mode === '120000' || child.mode === '160000')
        fail('review_skills_git_nonregular', {
          path: `${source.root}/${child.name}`,
        });
      if (child.type !== 'tree') continue;
      const skill = (
        await tree(child.oid, `${source.root}/${child.name}`, budget)
      ).find((entry) => entry.name === 'SKILL.md');
      if (!skill) continue;
      if (!/^100(?:644|755)$/.test(skill.mode) || skill.type !== 'blob')
        fail('review_skills_git_nonregular', {
          path: `${source.root}/${child.name}/SKILL.md`,
        });
      const directory = `${source.root}/${child.name}`;
      sources.push({ directory, path: `${directory}/SKILL.md`, budget });
      if (
        sources.length + capture.webSkills.length >
        reviewSkillsLimits.skillsPerRun
      )
        fail('review_skills_count_invalid', {
          path: source.root,
          field: 'root',
        });
    }
    const skillCount = sources.length - before;
    gitRoots.push({
      root: source.root,
      status: skillCount ? 'loaded' : 'empty',
      skillCount,
    });
  }
  let totalBytes = Buffer.byteLength(JSON.stringify(capture));
  const skills: MaterializedReviewSkill[] = [];
  for (const source of sources.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )) {
    const content = await read(
      source.path,
      reviewSkillsLimits.instructionsBytes,
      source.budget
    );
    let parsed: ReturnType<typeof parseGitReviewSkill>;
    try {
      parsed = parseGitReviewSkill(content);
    } catch (error) {
      throw attributeReviewSkillsError(error, {
        baseSha: input.baseSha,
        path: source.path,
        field: 'frontmatter',
      });
    }
    const resources = new Map<string, string>();
    const visiting = new Set<string>([source.path]);
    const visit = async (
      current: string,
      text: string,
      depth: number
    ): Promise<void> => {
      totalBytes += Buffer.byteLength(text);
      if (totalBytes > reviewSkillsLimits.bundleBytes)
        fail('review_skills_bundle_too_large', { path: current });
      let references: readonly string[];
      try {
        references = markdownReferences(text);
      } catch (error) {
        throw attributeReviewSkillsError(error, {
          baseSha: input.baseSha,
          path: current,
          field: 'reference',
        });
      }
      for (const target of references) {
        if (depth >= reviewSkillsLimits.referenceDepth)
          fail('review_skills_reference_depth', {
            path: current,
            field: 'reference',
            reference: target,
          });
        const resolved = posix.normalize(
          posix.join(posix.dirname(current), target)
        );
        if (
          !resolved.startsWith(`${source.directory}/`) ||
          resolved === source.directory
        )
          fail('review_skills_reference_traversal', {
            path: current,
            field: 'reference',
            reference: target,
          });
        if (visiting.has(resolved))
          fail('review_skills_reference_cycle', {
            path: current,
            field: 'reference',
            reference: target,
          });
        if (resources.has(resolved)) continue;
        if (resources.size >= reviewSkillsLimits.referencesPerSkill)
          fail('review_skills_reference_count', {
            path: current,
            field: 'reference',
            reference: target,
          });
        let reference: string;
        try {
          reference = await read(
            resolved,
            reviewSkillsLimits.referenceBytes,
            source.budget
          );
        } catch (error) {
          // Source and requested reference are useful; no raw read/parser error is retained.
          const attributed = attributeReviewSkillsError(error, {
            baseSha: input.baseSha,
          });
          throw new ReviewSkillsMaterializationError(attributed.code, {
            baseSha: input.baseSha,
            path: current,
            field: 'reference',
            reference: target,
          });
        }
        resources.set(resolved, reference);
        visiting.add(resolved);
        await visit(resolved, reference, depth + 1);
        visiting.delete(resolved);
      }
    };
    await visit(source.path, parsed.instructions, 0);
    skills.push({
      skillId: `git:${source.directory}`,
      revisionId: capture.baseSha,
      origin: 'git',
      ...parsed,
      includePaths: ['**'],
      excludePaths: [],
      resources: [...resources.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, content]) => ({ path, content })),
    });
  }
  try {
    return Object.freeze({
      executionInput: createMaterializedReviewSkills(capture, skills),
      gitRoots: Object.freeze(gitRoots.map((root) => Object.freeze(root))),
    });
  } catch (error) {
    throw attributeReviewSkillsError(error, { baseSha: input.baseSha });
  }
}

export function parseGitReviewSkill(content: string): Readonly<{
  name: string;
  description: string;
  instructions: string;
}> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(
    content
  );
  if (!match || /(?:^|[\s:[,{])[&*][A-Za-z0-9_-]+/mu.test(match[1]))
    throw new Error('review_skills_frontmatter_invalid');
  let value: unknown;
  try {
    value = load(match[1], { schema: JSON_SCHEMA });
  } catch {
    throw new Error('review_skills_frontmatter_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('review_skills_frontmatter_invalid');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'name',
          'description',
          'license',
          'compatibility',
          'metadata',
        ].includes(key)
    )
  )
    throw new Error('review_skills_frontmatter_unsupported');
  if (
    typeof row.name !== 'string' ||
    !row.name.trim() ||
    [...row.name].length > reviewSkillsLimits.nameCharacters
  )
    throw new ReviewSkillsMaterializationError(
      'review_skills_frontmatter_invalid',
      { field: 'name' }
    );
  if (
    typeof row.description !== 'string' ||
    !row.description.trim() ||
    [...row.description].length > reviewSkillsLimits.descriptionCharacters
  )
    throw new ReviewSkillsMaterializationError(
      'review_skills_frontmatter_invalid',
      { field: 'description' }
    );
  if (!match[2].trim())
    throw new ReviewSkillsMaterializationError(
      'review_skills_frontmatter_invalid',
      { field: 'instructions' }
    );
  for (const key of ['license', 'compatibility'])
    if (row[key] !== undefined && typeof row[key] !== 'string')
      throw new Error('review_skills_frontmatter_invalid');
  if (
    row.metadata !== undefined &&
    (!row.metadata ||
      typeof row.metadata !== 'object' ||
      Array.isArray(row.metadata) ||
      Object.values(row.metadata).some((item) => typeof item !== 'string'))
  )
    throw new Error('review_skills_frontmatter_invalid');
  return {
    name: row.name,
    description: row.description,
    instructions: match[2],
  };
}

/** Deliberately small documented Markdown dialect. Resources remain inline
 * evidence/instructions; URLs and anchors never trigger network or git reads. */
export function markdownReferences(text: string): readonly string[] {
  const withoutCode = text
    .replace(/```[^\n]*\n[\s\S]*?```/gu, '')
    .replace(/~~~[^\n]*\n[\s\S]*?~~~/gu, '')
    .replace(/(`+)[^\n]*?\1/gu, '');
  const targets: string[] = [];
  const definitions = new Map<string, string>();
  const normalize = (id: string) =>
    id.trim().replace(/\s+/gu, ' ').toLowerCase();
  for (const matched of withoutCode.matchAll(
    /^\s{0,3}\[([^\]]+)\]:\s*(.+)$/gmu
  )) {
    const key = normalize(matched[1]);
    if (definitions.has(key))
      throw new Error('review_skills_reference_invalid');
    definitions.set(key, matched[2].trim());
  }
  for (const matched of withoutCode.matchAll(
    /(?<!!)\[([^\]\n]+)\]\(([^)\n]*)\)/gu
  ))
    targets.push(matched[2]);
  for (const matched of withoutCode.matchAll(
    /(?<!!)\[([^\]\n]+)\]\[([^\]\n]*)\]/gu
  )) {
    const target = definitions.get(normalize(matched[2] || matched[1]));
    if (!target) throw new Error('review_skills_reference_missing');
    targets.push(target);
  }
  // Definitions alone are inert. Strip supported links (including image forms)
  // before checking shortcuts so their labels and destinations are not uses.
  const shortcutText = withoutCode
    .replace(/^\s{0,3}\[[^\]]+\]:\s*.+$/gmu, '')
    .replace(/!?\[[^\]\n]*\]\([^\n)]*\)/gu, '')
    .replace(/!?\[[^\]\n]*\]\[[^\]\n]*\]/gu, '');
  for (const matched of shortcutText.matchAll(/(?<![!\\])\[([^\]\n]+)\]/gu)) {
    const target = definitions.get(normalize(matched[1]));
    if (
      target &&
      !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(target) &&
      /\.md(?:[?#\s>]|$)/iu.test(target)
    )
      throw new Error('review_skills_reference_unsupported');
  }
  const refs = new Set<string>();
  for (const target of targets) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(target)) continue;
    if (
      !/^[^\s%<>\\?#]+\.md(?:#[^\s]*)?$/iu.test(target) ||
      target.startsWith('/')
    )
      throw new Error('review_skills_reference_unsupported');
    refs.add(target.split('#')[0]);
  }
  // HTML local resource references do not materialize additional files.
  if (/<[^>]+(?:href|src)\s*=\s*["'][^"']*\.md/iu.test(withoutCode))
    throw new Error('review_skills_reference_unsupported');
  return [...refs].sort();
}
