/** Closed, text-free diagnostics for repository Skills. Never retain parser or Git errors. */
const remedies = {
  review_skills_capture_mismatch:
    'Retry with the captured trusted base commit available.',
  review_skills_git_root_invalid: 'Select a supported repository Skills root.',
  review_skills_git_tree_too_large:
    'Reduce the number or size of files under this Skills root.',
  review_skills_git_read_failed:
    'Ensure the captured base commit and its Git objects are available, then retry.',
  review_skills_git_path_invalid:
    'Use repository paths without control characters or backslashes.',
  review_skills_git_nonregular:
    'Replace symbolic links and Git links with regular files and directories.',
  review_skills_git_blob_too_large:
    'Reduce SKILL.md to 32 KiB or a Markdown reference to 16 KiB.',
  review_skills_git_text_invalid:
    'Save this repository file as valid UTF-8 text without NUL characters.',
  review_skills_count_invalid:
    'Keep the combined captured set to at most 32 Skills.',
  review_skills_bundle_too_large:
    'Reduce the combined instructions and references to at most 256 KiB.',
  review_skills_frontmatter_invalid:
    'Provide YAML frontmatter with a nonblank name and description, followed by nonblank instructions.',
  review_skills_frontmatter_unsupported:
    'Remove unsupported frontmatter fields. Executable Skills are not supported.',
  review_skills_reference_missing:
    'Add the referenced Markdown file or correct its relative link.',
  review_skills_reference_invalid: 'Use unique Markdown reference definitions.',
  review_skills_reference_unsupported:
    'Use a supported relative Markdown link without spaces, encoding, or a title.',
  review_skills_reference_traversal:
    'Keep each reference inside its originating Skill directory.',
  review_skills_reference_cycle: 'Remove the circular Markdown reference.',
  review_skills_reference_depth: 'Keep Markdown references within four levels.',
  review_skills_reference_count:
    'Keep each Skill to at most eight Markdown references.',
} as const;

export type ReviewSkillsErrorCode = keyof typeof remedies;
export type ReviewSkillsErrorField =
  | 'root'
  | 'frontmatter'
  | 'name'
  | 'description'
  | 'instructions'
  | 'reference';
export type ReviewSkillsErrorContext = Readonly<{
  baseSha?: string;
  path?: string;
  field?: ReviewSkillsErrorField;
  reference?: string;
}>;

function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const characters = Array.from(value);
  return (
    characters
      .slice(0, characters.length > 256 ? 255 : 256)
      .map((character) => {
        const code = character.codePointAt(0)!;
        return code < 32 || code === 127 ? ' ' : character;
      })
      .join('') + (characters.length > 256 ? '…' : '')
  );
}

export class ReviewSkillsMaterializationError extends Error {
  readonly diagnostic: ReviewSkillsErrorContext;
  readonly remediation: string;
  constructor(
    readonly code: ReviewSkillsErrorCode,
    context: ReviewSkillsErrorContext = {}
  ) {
    super(code);
    this.name = 'ReviewSkillsMaterializationError';
    this.remediation = remedies[code];
    this.diagnostic = Object.freeze({
      ...(context.baseSha && /^[a-f0-9]{40}$/.test(context.baseSha)
        ? { baseSha: context.baseSha }
        : {}),
      ...(context.path === undefined ? {} : { path: bounded(context.path) }),
      ...(context.field === undefined ? {} : { field: context.field }),
      ...(context.reference === undefined
        ? {}
        : { reference: bounded(context.reference) }),
    });
  }
}

export function attributeReviewSkillsError(
  error: unknown,
  context: ReviewSkillsErrorContext
): ReviewSkillsMaterializationError {
  const code =
    error instanceof Error && Object.hasOwn(remedies, error.message)
      ? (error.message as ReviewSkillsErrorCode)
      : 'review_skills_git_read_failed';
  return new ReviewSkillsMaterializationError(code, {
    ...context,
    ...(error instanceof ReviewSkillsMaterializationError
      ? error.diagnostic
      : {}),
  });
}

/** Inline code with entities prevents Markdown, HTML and mentions from becoming active. */
export function renderReviewSkillsDiagnosticText(value: string): string {
  return `<code>${(bounded(value) ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('`', '&#96;').replaceAll('@', '&#64;').replaceAll('[', '&#91;').replaceAll(']', '&#93;').replaceAll('|', '&#124;')}</code>`;
}
