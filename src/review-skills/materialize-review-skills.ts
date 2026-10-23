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

type TreeEntry = Readonly<{
  mode: string;
  type: string;
  oid: string;
  name: string;
}>;
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
  const capture = structuredClone(input.capture);
  if (
    !/^[a-f0-9]{40}$/.test(input.baseSha) ||
    capture.baseSha !== input.baseSha
  )
    throw new Error('review_skills_capture_mismatch');
  const trees = new Map<string, readonly TreeEntry[]>();
  const git = async (
    args: readonly string[],
    maxBuffer: number
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
      throw new Error('review_skills_git_read_failed');
    }
  };
  const tree = async (oid: string): Promise<readonly TreeEntry[]> => {
    const previous = trees.get(oid);
    if (previous) return previous;
    const bytes = await git(['ls-tree', '-z', oid], TREE_BYTES);
    const entries = decoder
      .decode(bytes)
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
          throw new Error('review_skills_git_path_invalid');
        return {
          mode: matched[1],
          type: matched[2],
          oid: matched[3],
          name: matched[4],
        };
      });
    if (entries.length > reviewSkillsLimits.treeEntries)
      throw new Error('review_skills_git_tree_too_large');
    trees.set(oid, entries);
    return entries;
  };
  const find = async (path: string): Promise<TreeEntry | null> => {
    let oid = input.baseSha;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entry = (await tree(oid)).find((item) => item.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) return entry;
      if (entry.mode !== '040000' || entry.type !== 'tree')
        throw new Error('review_skills_git_nonregular');
      oid = entry.oid;
    }
    return null;
  };
  const read = async (path: string, limit: number): Promise<string> => {
    const entry = await find(path);
    if (!entry) throw new Error('review_skills_reference_missing');
    if (!/^100(?:644|755)$/.test(entry.mode) || entry.type !== 'blob')
      throw new Error('review_skills_git_nonregular');
    const size = Number(
      decoder.decode(await git(['cat-file', '-s', entry.oid], 128)).trim()
    );
    if (!Number.isSafeInteger(size) || size > limit)
      throw new Error('review_skills_git_blob_too_large');
    const content = decoder.decode(
      await git(['cat-file', 'blob', entry.oid], limit + 1)
    );
    if (content.includes('\0'))
      throw new Error('review_skills_git_text_invalid');
    return content;
  };
  const sources: { path: string; directory: string }[] = [];
  for (const source of capture.gitSources) {
    if (
      source.root !== '.reviewrouter/skills' &&
      source.root !== '.agents/skills'
    )
      throw new Error('review_skills_git_root_invalid');
    const root = await find(source.root);
    if (!root) continue;
    if (root.mode !== '040000' || root.type !== 'tree')
      throw new Error('review_skills_git_nonregular');
    for (const child of await tree(root.oid)) {
      if (child.mode === '120000' || child.mode === '160000')
        throw new Error('review_skills_git_nonregular');
      if (child.type !== 'tree') continue;
      const skill = (await tree(child.oid)).find(
        (entry) => entry.name === 'SKILL.md'
      );
      if (!skill) continue;
      if (!/^100(?:644|755)$/.test(skill.mode) || skill.type !== 'blob')
        throw new Error('review_skills_git_nonregular');
      const directory = `${source.root}/${child.name}`;
      sources.push({ directory, path: `${directory}/SKILL.md` });
      if (
        sources.length + capture.webSkills.length >
        reviewSkillsLimits.skillsPerRun
      )
        throw new Error('review_skills_count_invalid');
    }
  }
  let totalBytes = Buffer.byteLength(JSON.stringify(capture));
  const skills: MaterializedReviewSkill[] = [];
  for (const source of sources.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )) {
    const content = await read(
      source.path,
      reviewSkillsLimits.instructionsBytes
    );
    const parsed = parseGitReviewSkill(content);
    const resources = new Map<string, string>();
    const visiting = new Set<string>([source.path]);
    const visit = async (
      current: string,
      text: string,
      depth: number
    ): Promise<void> => {
      totalBytes += Buffer.byteLength(text);
      if (totalBytes > reviewSkillsLimits.bundleBytes)
        throw new Error('review_skills_bundle_too_large');
      for (const target of markdownReferences(text)) {
        if (depth >= reviewSkillsLimits.referenceDepth)
          throw new Error('review_skills_reference_depth');
        const resolved = posix.normalize(
          posix.join(posix.dirname(current), target)
        );
        if (
          !resolved.startsWith(`${source.directory}/`) ||
          resolved === source.directory
        )
          throw new Error('review_skills_reference_traversal');
        if (visiting.has(resolved))
          throw new Error('review_skills_reference_cycle');
        if (resources.has(resolved)) continue;
        if (resources.size >= reviewSkillsLimits.referencesPerSkill)
          throw new Error('review_skills_reference_count');
        const reference = await read(
          resolved,
          reviewSkillsLimits.referenceBytes
        );
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
  return createMaterializedReviewSkills(capture, skills);
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
    [...row.name].length > reviewSkillsLimits.nameCharacters ||
    typeof row.description !== 'string' ||
    !row.description.trim() ||
    [...row.description].length > reviewSkillsLimits.descriptionCharacters ||
    !match[2].trim()
  )
    throw new Error('review_skills_frontmatter_invalid');
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
