/** Stable terminal and machine contract for local review, independent of the engine. */
export type LocalReviewEngineId = 'legacy' | 'ocr';
export type LocalReviewScope =
  | Readonly<{ kind: 'worktree' }>
  | Readonly<{ kind: 'branch'; base: string; head?: string; comparison?: 'tips' }>
  | Readonly<{ kind: 'commit'; ref: string }>;
export type LocalReviewStatus = 'complete' | 'partial' | 'failed' | 'stale' | 'skipped';
export type LocalReviewSeverity = 'critical' | 'major' | 'minor' | 'unclassified';

export interface LocalReviewFinding {
  path: string;
  line: number | null;
  endLine: number | null;
  severity: LocalReviewSeverity;
  nativeSeverity?: string;
  title: string;
  message: string;
  suggestion?: string;
}
export interface LocalReviewOutcome {
  schemaVersion: 1;
  engine: { id: LocalReviewEngineId; version: string | null };
  status: LocalReviewStatus;
  input: { scope: LocalReviewScope['kind']; base: string | null; head: string | null; snapshotDigest: string };
  coverage: { selected: number; reviewed: number; omitted: string[]; complete: boolean; selectedPaths?: string[] };
  provider: { name: string | null; model: string | null };
  findings: LocalReviewFinding[];
  summary: { critical: number; major: number; minor: number; unclassified: number };
  blocking: boolean;
  warnings: string[];
}

export interface LocalReviewRunRequest {
  engine: LocalReviewEngineId;
  scope: LocalReviewScope;
  includeUntracked: boolean;
  provider?: string;
  model?: string;
  preview: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}

/** These errors occur before inference and must not be treated as a review. */
export class LocalReviewExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalReviewExecutionError';
  }
}

export class LocalReviewInterruptedError extends Error {
  constructor() {
    super('Local review interrupted.');
    this.name = 'LocalReviewInterruptedError';
  }
}

export class LocalReviewUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalReviewUsageError';
  }
}

export function summaryFromFindings(findings: readonly LocalReviewFinding[]): LocalReviewOutcome['summary'] {
  const summary = { critical: 0, major: 0, minor: 0, unclassified: 0 };
  for (const finding of findings) summary[finding.severity]++;
  return summary;
}

export function exitCodeForLocalOutcome(result: LocalReviewOutcome): number {
  if (result.status === 'partial' || result.status === 'failed' || result.status === 'stale') return 3;
  if (result.status === 'skipped') return 0; // status remains explicit, not a green review
  if (result.summary.critical > 0) return 2;
  if (result.summary.major > 0 || result.blocking) return 1;
  return 0;
}

export function renderLocalReview(result: LocalReviewOutcome): string {
  const lines = [
    `ReviewRouter local review — ${result.engine.id} (${result.engine.version ?? 'unknown version'})`,
    `Status: ${result.status} | scope: ${result.input.scope} | ${result.coverage.reviewed}/${result.coverage.selected} files reviewed`,
    `Findings: ${result.summary.critical} critical, ${result.summary.major} major, ${result.summary.minor} minor, ${result.summary.unclassified} unclassified`,
  ];
  for (const finding of result.findings) {
    const location = finding.line === null ? `${finding.path} (location unverified)` : `${finding.path}:${finding.line}`;
    lines.push(`${location} [${finding.nativeSeverity ?? finding.severity}] ${finding.title}`);
    if (finding.message !== finding.title) lines.push(`  ${finding.message}`);
  }
  if (result.status === 'skipped' && result.coverage.selectedPaths?.length) {
    const paths = result.coverage.selectedPaths;
    lines.push(`Would review ${paths.length} file(s):`);
    for (const file of paths.slice(0, 20)) lines.push(`  ${file}`);
    if (paths.length > 20) lines.push(`  ... and ${paths.length - 20} more (use --format json)`);
  }
  for (const warning of result.warnings) lines.push(`Notice: ${warning}`);
  if (result.status === 'partial' || result.status === 'failed' || result.status === 'stale') {
    lines.push('Review is not complete; no clean result can be inferred.');
  }
  return lines.join('\n');
}

