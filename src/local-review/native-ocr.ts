/** Native OCR execution boundary. Never calls the hosted --reviewrouter-managed path. */
import { spawn } from 'child_process';
import * as path from 'path';
import { statSync } from 'fs';
import { LocalReviewFinding, LocalReviewOutcome, LocalReviewRunRequest, LocalReviewUsageError, LocalReviewExecutionError, LocalReviewInterruptedError, summaryFromFindings } from './contracts';
import { LocalGitSnapshot } from './git-snapshot';

const MAX_STDOUT = 16 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const PREVIEW_TIMEOUT_MS = 45_000;
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const NATIVE_MANIFEST_VERSION = 'ocr.run-manifest/v1';

export interface NativeProcessResult { exitCode: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null }
export type NativeProcessRunner = (command: string, args: readonly string[], options: { cwd: string; timeoutMs: number; maxOutput: number; signal?: AbortSignal }) => Promise<NativeProcessResult>;

export const runNativeProcess: NativeProcessRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const out: Buffer[] = [], err: Buffer[] = [];
  let outSize = 0, errSize = 0;
  let abortReason: string | null = null;
  const fail = (reason: string): void => { abortReason = reason; child.kill(); };
  const timeout = setTimeout(() => fail('Native OCR exceeded the local review timeout.'), options.timeoutMs);
  const abort = (): void => fail('Local review interrupted.');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  child.stdout.on('data', (chunk: Buffer) => {
    outSize += chunk.length;
    if (outSize > options.maxOutput) fail('Native OCR JSON exceeded the output limit.');
    else out.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errSize += chunk.length;
    if (errSize > MAX_STDERR) fail('Native OCR diagnostics exceeded the output limit.');
    else err.push(chunk);
  });
  child.on('error', () => { abortReason = 'Native OCR executable unavailable or cannot start.'; });
  child.on('close', (exitCode, signal) => {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    if (abortReason === 'Local review interrupted.') reject(new LocalReviewInterruptedError());
    else if (abortReason === 'Native OCR executable unavailable or cannot start.') reject(new LocalReviewUsageError(abortReason));
    else if (abortReason) reject(new LocalReviewExecutionError(abortReason));
    else resolve({ exitCode, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
  });
});

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function requiredRecord(value: unknown, kind: string): Record<string, unknown> {
  const obj = record(value);
  if (!obj) throw new Error(`Invalid native OCR ${kind} response.`);
  return obj;
}
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function safePath(value: unknown): string {
  if (typeof value !== 'string' || !value || containsControlCharacters(value) || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new Error('Native OCR returned an unsafe path.');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized !== value) {
    throw new Error('Native OCR returned a non-canonical path.');
  }
  return normalized;
}
function stringField(value: unknown, max = 4000): string | null {
  return typeof value === 'string'
    ? value.replace(ANSI_ESCAPE_SEQUENCE, '').split('').filter(character => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    }).join('').slice(0, max)
    : null;
}
function parseJson(text: string, what: string): Record<string, unknown> {
  try { return requiredRecord(JSON.parse(text), what); }
  catch { throw new Error(`Native OCR ${what} was not a valid JSON object.`); }
}
function previewSelected(preview: Record<string, unknown>): string[] {
  if (!Array.isArray(preview.files) || preview.files.length > 5000) {
    throw new Error('Native OCR preview omitted the bounded file inventory.');
  }
  const selected: string[] = [];
  for (const item of preview.files) {
    const f = requiredRecord(item, 'preview file');
    if (typeof f.will_review !== 'boolean') throw new Error('Native OCR preview file has no selection decision.');
    if (f.will_review) selected.push(safePath(f.path));
  }
  if (new Set(selected).size !== selected.length || preview.reviewable_count !== selected.length) {
    throw new Error('Native OCR preview file selection is inconsistent.');
  }
  return selected.sort();
}
function coverageSet(value: unknown, name: string): { itemId: string; path: string }[] {
  if (!Array.isArray(value) || value.length > 5000) throw new Error(`Invalid OCR manifest ${name} set.`);
  return value.map(item => {
    const c = requiredRecord(item, `manifest ${name} item`);
    if (typeof c.item_id !== 'string' || !/^[a-f0-9]{64}$/.test(c.item_id)) {
      throw new Error('Native OCR manifest item identity invalid.');
    }
    return { itemId: c.item_id, path: safePath(c.path) };
  });
}
function findingFromNative(value: unknown, selected: ReadonlySet<string>): LocalReviewFinding {
  const c = requiredRecord(value, 'comment');
  const file = safePath(c.path);
  if (!selected.has(file)) throw new Error('Native OCR comment targets a file outside the selected review.');
  const start = typeof c.start_line === 'number' && Number.isSafeInteger(c.start_line) && c.start_line >= 0 ? c.start_line : null;
  if (start === null) throw new Error('Native OCR comment has an invalid line location.');
  const end = typeof c.end_line === 'number' && Number.isSafeInteger(c.end_line) && c.end_line >= start ? c.end_line : start;
  const nativeSeverity = stringField(c.severity, 40) ?? '';
  // Explicit taxonomy translation. Missing/unknown severity is not guessed.
  const severity = nativeSeverity === 'critical' ? 'critical'
    : nativeSeverity === 'high' ? 'major'
      : nativeSeverity === 'medium' || nativeSeverity === 'low' ? 'minor' : 'unclassified';
  const message = stringField(c.content, 8000) ?? '';
  if (!message) throw new Error('Native OCR comment missing the finding description.');
  const title = message.split('\n')[0].slice(0, 180);
  const suggestion = stringField(c.suggestion_code, 5000);
  return { path: file, line: start === 0 ? null : start, endLine: end === 0 ? null : end, severity,
    ...(nativeSeverity ? { nativeSeverity } : {}), title, message,
    ...(suggestion ? { suggestion } : {}),
  };
}

/** Strictly normalize the pinned native terminal coverage manifest, not exit-0. */
export function normalizeNativeOcrResult(
  raw: unknown, selectedPaths: readonly string[], snapshot: LocalGitSnapshot, version: string
): LocalReviewOutcome {
  const obj = requiredRecord(raw, 'result');
  const manifest = requiredRecord(obj.manifest, 'coverage manifest');
  if (manifest.schema_version !== NATIVE_MANIFEST_VERSION || manifest.operation !== 'review') {
    throw new Error('Native OCR coverage schema/version not qualified.');
  }
  const expectedMode = snapshot.scope.kind === 'branch' ? 'range' : snapshot.scope.kind === 'commit' ? 'commit' : 'workspace';
  const input = requiredRecord(manifest.input, 'input');
  if (input.mode !== expectedMode) throw new Error('Native OCR reviewed a different input scope.');
  if (snapshot.scope.kind !== 'worktree' && input.resolved_head !== snapshot.head) {
    throw new Error('Native OCR reviewed a different Git head.');
  }
  if (snapshot.scope.kind === 'branch' && input.resolved_base !== snapshot.base) {
    throw new Error('Native OCR reviewed a different Git base.');
  }
  const c = requiredRecord(manifest.coverage, 'coverage');
  const selected = coverageSet(c.selected, 'selected');
  const completed = coverageSet(c.completed, 'completed');
  const reused = coverageSet(c.reused, 'reused');
  const failed = coverageSet(c.failed, 'failed');
  const waived = coverageSet(c.waived, 'waived');
  const ids = new Map(selected.map(x => [x.itemId, x.path]));
  const paths = selected.map(x => x.path).sort();
  if (ids.size !== selected.length || new Set(paths).size !== paths.length ||
      JSON.stringify(paths) !== JSON.stringify([...selectedPaths].sort())) {
    throw new Error('Native OCR selected coverage differs from model-free preview.');
  }
  const assigned = new Set<string>();
  for (const item of [...completed, ...reused, ...failed, ...waived]) {
    if (ids.get(item.itemId) !== item.path || assigned.has(item.itemId)) {
      throw new Error('Native OCR manifest has missing, duplicate or foreign coverage.');
    }
    assigned.add(item.itemId);
  }
  if (assigned.size !== ids.size) throw new Error('Native OCR coverage is not exhaustive.');
  const terminal = manifest.terminal_state;
  if (!['complete', 'partial', 'failed', 'skipped'].includes(String(terminal)) || obj.status !== terminal) {
    throw new Error('Native OCR manifest and terminal status disagree.');
  }
  if (!Array.isArray(obj.comments) || obj.comments.length > 3000) {
    throw new Error('Native OCR comments are missing or exceed the review limit.');
  }
  const selectedSet = new Set(paths);
  const findings = obj.comments.map(v => findingFromNative(v, selectedSet));
  const execution = record(manifest.execution);
  const llm = record(obj.llm);
  const observedModel = stringField(llm?.model, 150);
  const manifestModel = stringField(execution?.model, 150);
  if (observedModel && manifestModel && observedModel !== manifestModel) {
    throw new Error('Native OCR model attribution differs from manifest.');
  }
  const omitted = [...failed, ...waived].map(x => x.path);
  if (obj.warnings !== undefined && !Array.isArray(obj.warnings)) {
    throw new Error('Native OCR warnings field has an invalid structure.');
  }
  const runFailure = manifest.run_failure;
  if (runFailure != null && !record(runFailure)) {
    throw new Error('Native OCR run failure field has an invalid structure.');
  }
  const hasNativeWarnings = Array.isArray(obj.warnings) && obj.warnings.length > 0;
  const unanchoredFindings = findings.some(finding => finding.line === null);
  const model = observedModel ?? manifestModel;
  const complete = terminal === 'complete' && omitted.length === 0 &&
    completed.length + reused.length === selected.length && selected.length > 0 &&
    runFailure == null && !hasNativeWarnings && !unanchoredFindings && Boolean(model);
  const status = terminal === 'complete' && !complete ? 'partial' : terminal as LocalReviewOutcome['status'];
  const summary = summaryFromFindings(findings);
  const warnings: string[] = [];
  if (hasNativeWarnings) warnings.push('Native OCR emitted warnings; inspect its local session for details.');
  if (unanchoredFindings) warnings.push('Some native findings have no verified source location; inspect the referenced files.');
  if (!model) warnings.push('Native OCR did not establish the executed model identity.');
  return {
    schemaVersion: 1, engine: { id: 'ocr', version }, status,
    input: { scope: snapshot.scope.kind, base: snapshot.base, head: snapshot.head, snapshotDigest: snapshot.digest },
    coverage: { selected: selected.length, reviewed: completed.length + reused.length, omitted, complete },
    provider: { name: stringField(llm?.provider, 150) ?? stringField(execution?.provider, 150), model },
    findings, summary, blocking: summary.critical > 0 || summary.major > 0, warnings,
  };
}

export class NativeOcrEngine {
  constructor(private readonly runner: NativeProcessRunner = runNativeProcess) {}

  private binary(): string {
    const userOverride = process.env.REVIEWROUTER_OCR_BINARY;
    if (userOverride && !path.isAbsolute(userOverride)) {
      throw new LocalReviewUsageError('REVIEWROUTER_OCR_BINARY must be an absolute trusted executable path.');
    }
    if (userOverride) return userOverride;
    // Do not let a repository-local binary shadow OCR on Windows or via a
    // relative PATH entry. Only an explicitly trusted absolute override or an
    // executable found in an absolute PATH directory may be launched.
    const executable = process.platform === 'win32' ? 'ocr.exe' : 'ocr';
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!directory || !path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, executable);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // PATH entries frequently refer to absent/removed directories.
      }
    }
    throw new LocalReviewUsageError(
      'Native OCR executable not found in absolute PATH directories; set REVIEWROUTER_OCR_BINARY to a trusted absolute path.'
    );
  }

  async doctor(root: string): Promise<string> {
    const binary = this.binary();
    const result = await this.runner(binary, ['version'], { cwd: root, timeoutMs: 10_000, maxOutput: 16_384 });
    const version = result.stdout.match(/(?:^|[^0-9A-Za-z])v?(1\.13\.1(?:-rr\.\d+)?)(?![0-9A-Za-z])/);
    if (result.exitCode !== 0 || result.signal !== null || !version) {
      throw new LocalReviewUsageError('Native OCR v1.13.1 is required for this qualified adapter; install the pinned version.');
    }
    return version[1];
  }

  async run(snapshot: LocalGitSnapshot, request: LocalReviewRunRequest): Promise<LocalReviewOutcome> {
    const binary = this.binary();
    const version = await this.doctor(snapshot.root);
    const modeArgs: string[] = [];
    if (snapshot.scope.kind === 'branch') modeArgs.push('--from', snapshot.base!, '--to', snapshot.head!);
    if (snapshot.scope.kind === 'commit') modeArgs.push('--commit', snapshot.head!);
    const args = ['review', '--repo', snapshot.root, ...modeArgs, '--format', 'json', '--audience', 'agent'];
    if (request.provider) args.push('--provider', request.provider);
    if (request.model) args.push('--model', request.model);
    const preview = await this.runner(binary, [...args, '--preview'], { cwd: snapshot.root, timeoutMs: PREVIEW_TIMEOUT_MS, maxOutput: MAX_STDOUT, signal: request.signal });
    if (preview.exitCode !== 0 || preview.signal !== null) throw new Error('Native OCR could not preview the selected files.');
    const selected = previewSelected(parseJson(preview.stdout, 'preview'));
    if (selected.length === 0) {
      const empty: LocalReviewFinding[] = [];
      return { schemaVersion: 1, engine: { id: 'ocr', version }, status: 'skipped',
        input: { scope: snapshot.scope.kind, base: snapshot.base, head: snapshot.head, snapshotDigest: snapshot.digest },
        coverage: { selected: 0, reviewed: 0, omitted: [], complete: false },
        provider: { name: request.provider ?? null, model: request.model ?? null },
        findings: empty, summary: summaryFromFindings(empty), blocking: false,
        warnings: ['No eligible files selected by native OCR; no model was called.'] };
    }
    if (request.preview) {
      const empty: LocalReviewFinding[] = [];
      return { schemaVersion: 1, engine: { id: 'ocr', version }, status: 'skipped',
        input: { scope: snapshot.scope.kind, base: snapshot.base, head: snapshot.head, snapshotDigest: snapshot.digest },
        coverage: { selected: selected.length, reviewed: 0, omitted: selected, complete: false },
        provider: { name: request.provider ?? null, model: request.model ?? null },
        findings: empty, summary: summaryFromFindings(empty), blocking: false,
        warnings: ['Preview only: no model was called.'] };
    }
    const actual = await this.runner(binary, args, { cwd: snapshot.root, timeoutMs: REVIEW_TIMEOUT_MS, maxOutput: MAX_STDOUT, signal: request.signal });
    if (actual.exitCode !== 0 || actual.signal !== null) throw new Error('Native OCR process did not complete successfully.');
    const result = normalizeNativeOcrResult(parseJson(actual.stdout, 'result'), selected, snapshot, version);
    if (request.model && result.provider.model && result.provider.model !== request.model) {
      throw new Error('Observed native OCR model differed from the explicit model request.');
    }
    return result;
  }
}
