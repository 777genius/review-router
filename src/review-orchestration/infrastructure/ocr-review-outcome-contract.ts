/**
 * Versioned vendor contract consumed at the OCR adapter boundary.
 *
 * Two sides share one contract:
 *  - the managed Go producer freezes `reviewrouter_outcome` into the native
 *    jsonOutput (plan 56, §7.3-7.4);
 *  - this TS boundary parser validates it strictly before any normalization.
 *
 * Consumer rules (§7.4): closed enums for terminal values, unknown wire
 * values reject, missing required fields never default to "success",
 * contradictory fields are a contract failure. Optional extra native fields
 * are ignored. This is not a schema framework; it is one bounded parser.
 */

export const OCR_OUTCOME_SCHEMA_VERSION = 'reviewrouter.ocr-outcome/v1';

export type OcrPhaseState =
  | 'completed'
  | 'not_applicable'
  | 'failed'
  | 'cancelled';

export type OcrRunStopCause =
  | 'max_rounds'
  | 'empty_rounds'
  | 'compression'
  | 'token_budget'
  | 'prompt_budget'
  | 'provider_error'
  | 'input_error'
  | 'internal_error'
  | 'cancelled'
  | 'deadline';

const OCR_PHASE_STATES: readonly OcrPhaseState[] = [
  'completed',
  'not_applicable',
  'failed',
  'cancelled',
];

const OCR_STOP_CAUSES: readonly OcrRunStopCause[] = [
  'max_rounds',
  'empty_rounds',
  'compression',
  'token_budget',
  'prompt_budget',
  'provider_error',
  'input_error',
  'internal_error',
  'cancelled',
  'deadline',
];

/** Native stop aliases the producer documents; unknown wire values reject. */
const OCR_STOP_CAUSE_ALIASES: Readonly<Record<string, OcrRunStopCause>> = {
  review_limit_reached: 'max_rounds',
};

export type OcrOutcomePhase = Readonly<{
  state: OcrPhaseState;
  reason: string | null;
}>;

export type OcrOutcomeGroup = Readonly<{
  paths: readonly string[];
  mainCompleted: boolean;
  stopCause: OcrRunStopCause | null;
  rounds: Readonly<{ configured: number; started: number; completed: number }>;
  phases: Readonly<{
    plan: OcrOutcomePhase;
    compression: OcrOutcomePhase;
    relocation: OcrOutcomePhase;
    filter: OcrOutcomePhase;
  }>;
  /** Group-level §7.4 field; never nested inside phases.filter. */
  filterDecisionValid: boolean | null;
}>;

export type OcrReviewOutcome = Readonly<{
  schemaVersion: typeof OCR_OUTCOME_SCHEMA_VERSION;
  runStopCause: OcrRunStopCause | null;
  grouping: Readonly<{ state: OcrPhaseState; reason: string | null }>;
  groups: readonly OcrOutcomeGroup[];
}>;

export type OcrContractIssue = Readonly<{
  code: string;
  detail: string;
}>;

export class OcrManagedContractViolation extends Error {
  readonly issues: readonly OcrContractIssue[];

  constructor(issues: readonly OcrContractIssue[]) {
    super(
      `ocr_managed_outcome_contract_violation: ${issues
        .map((issue) => issue.code)
        .join(',')}`
    );
    this.name = 'OcrManagedContractViolation';
    this.issues = Object.freeze([...issues]);
  }
}

export class OcrNativeResultContractViolation extends Error {
  readonly issues: readonly OcrContractIssue[];

  constructor(issues: readonly OcrContractIssue[]) {
    super(
      `ocr_native_result_contract_violation: ${issues
        .map((issue) => issue.code)
        .join(',')}`
    );
    this.name = 'OcrNativeResultContractViolation';
    this.issues = Object.freeze([...issues]);
  }
}

/** Aggregate phase state priority: cancelled > failed > completed > not_applicable. */
export function aggregateOcrPhaseState(
  states: readonly OcrPhaseState[]
): OcrPhaseState {
  const priority: Readonly<Record<OcrPhaseState, number>> = {
    cancelled: 3,
    failed: 2,
    completed: 1,
    not_applicable: 0,
  };
  let aggregate: OcrPhaseState = 'not_applicable';
  for (const state of states) {
    if (priority[state] > priority[aggregate]) aggregate = state;
  }
  return aggregate;
}

const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strict §7.4 `reviewrouter_outcome` parser. Throws
 * OcrManagedContractViolation on any missing/unknown/contradictory value.
 */
export function parseOcrReviewOutcome(value: unknown): OcrReviewOutcome {
  const issues: OcrContractIssue[] = [];
  const violation = (): never => {
    throw new OcrManagedContractViolation(issues);
  };
  if (!isRecord(value)) {
    issues.push({ code: 'outcome_not_an_object', detail: 'reviewrouter_outcome' });
    return violation();
  }
  if (value.schema_version !== OCR_OUTCOME_SCHEMA_VERSION) {
    issues.push({
      code: 'outcome_schema_version',
      detail: `expected ${OCR_OUTCOME_SCHEMA_VERSION}`,
    });
    return violation();
  }

  const parseStopCause = (
    raw: unknown,
    field: string
  ): OcrRunStopCause | null => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string' && OCR_STOP_CAUSES.includes(raw as OcrRunStopCause)) {
      return raw as OcrRunStopCause;
    }
    if (typeof raw === 'string' && OCR_STOP_CAUSE_ALIASES[raw] !== undefined) {
      return OCR_STOP_CAUSE_ALIASES[raw];
    }
    issues.push({ code: 'outcome_stop_cause_unknown', detail: field });
    return null;
  };

  const parseReason = (raw: unknown, field: string): string | null => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string' && REASON_PATTERN.test(raw)) return raw;
    issues.push({ code: 'outcome_reason_invalid', detail: field });
    return null;
  };

  const parseState = (raw: unknown, field: string): OcrPhaseState | null => {
    if (typeof raw === 'string' && OCR_PHASE_STATES.includes(raw as OcrPhaseState)) {
      return raw as OcrPhaseState;
    }
    issues.push({ code: 'outcome_phase_state_unknown', detail: field });
    return null;
  };

  const runStopCause = parseStopCause(value.run_stop_cause, 'run_stop_cause');
  // §7.4 rule 7: the producer always emits the field (null on a natural run
  // stop). A missing key is a contract failure, never a silent null that
  // would read as "the run stopped successfully".
  if (value.run_stop_cause === undefined) {
    issues.push({ code: 'outcome_stop_cause_missing', detail: 'run_stop_cause' });
    return violation();
  }
  if (
    value.run_stop_cause !== null &&
    value.run_stop_cause !== undefined &&
    runStopCause === null
  ) {
    return violation();
  }

  const groupingRaw = value.grouping;
  if (!isRecord(groupingRaw)) {
    issues.push({ code: 'outcome_grouping_missing', detail: 'grouping' });
    return violation();
  }
  const groupingState = parseState(groupingRaw.state, 'grouping.state');
  const groupingReason = parseReason(groupingRaw.reason, 'grouping.reason');
  if (groupingState === null) return violation();

  const groupsRaw = value.groups;
  if (!Array.isArray(groupsRaw)) {
    issues.push({ code: 'outcome_groups_missing', detail: 'groups' });
    return violation();
  }

  const seenPaths = new Set<string>();
  const groups = groupsRaw.map((groupRaw, groupIndex): OcrOutcomeGroup => {
    const field = (name: string) => `groups[${groupIndex}].${name}`;
    if (!isRecord(groupRaw)) {
      issues.push({ code: 'outcome_group_invalid', detail: field('group') });
      return violation();
    }

    const pathsRaw = groupRaw.paths;
    const paths: string[] = [];
    if (!Array.isArray(pathsRaw) || pathsRaw.length === 0) {
      issues.push({ code: 'outcome_group_paths_invalid', detail: field('paths') });
    } else {
      for (const path of pathsRaw) {
        if (typeof path !== 'string' || path.length === 0) {
          issues.push({ code: 'outcome_group_paths_invalid', detail: field('paths') });
          continue;
        }
        if (paths.includes(path) || seenPaths.has(path)) {
          issues.push({ code: 'outcome_group_paths_duplicate', detail: path });
          continue;
        }
        paths.push(path);
        seenPaths.add(path);
      }
    }

    const mainCompleted = groupRaw.main_completed;
    if (typeof mainCompleted !== 'boolean') {
      issues.push({
        code: 'outcome_main_completed_invalid',
        detail: field('main_completed'),
      });
      return violation();
    }
    const stopCause = parseStopCause(groupRaw.stop_cause, field('stop_cause'));
    // §7.4 rule 7: same as run_stop_cause — the key is always on the wire, so
    // a missing stop_cause must not silently read as the null of a natural
    // main completion.
    if (groupRaw.stop_cause === undefined) {
      issues.push({
        code: 'outcome_stop_cause_missing',
        detail: field('stop_cause'),
      });
      return violation();
    }
    if (groupRaw.stop_cause !== null && groupRaw.stop_cause !== undefined && stopCause === null) {
      return violation();
    }

    const roundsRaw = groupRaw.rounds;
    if (!isRecord(roundsRaw)) {
      issues.push({ code: 'outcome_rounds_invalid', detail: field('rounds') });
      return violation();
    }
    const roundCount = (raw: unknown): number | null =>
      Number.isSafeInteger(raw) && (raw as number) >= 0 ? (raw as number) : null;
    const configured = roundCount(roundsRaw.configured);
    const started = roundCount(roundsRaw.started);
    const completed = roundCount(roundsRaw.completed);
    if (configured === null || started === null || completed === null) {
      issues.push({ code: 'outcome_rounds_invalid', detail: field('rounds') });
      return violation();
    }
    if (!(completed <= started && started <= configured)) {
      issues.push({
        code: 'outcome_rounds_inconsistent',
        detail: field('rounds'),
      });
      return violation();
    }

    const phasesRaw = groupRaw.phases;
    if (!isRecord(phasesRaw)) {
      issues.push({ code: 'outcome_phases_invalid', detail: field('phases') });
      return violation();
    }
    const parsePhase = (name: string): OcrOutcomePhase | null => {
      const raw = phasesRaw[name];
      if (!isRecord(raw)) {
        issues.push({ code: 'outcome_phase_invalid', detail: field(`phases.${name}`) });
        return null;
      }
      const state = parseState(raw.state, field(`phases.${name}.state`));
      const reason = parseReason(raw.reason, field(`phases.${name}.reason`));
      if (state === null) return null;
      return Object.freeze({ state, reason });
    };
    const plan = parsePhase('plan');
    const compression = parsePhase('compression');
    const relocation = parsePhase('relocation');
    const filter = parsePhase('filter');
    // §7.4: filter_decision_valid is a group-level sibling of phases, never
    // nested inside the filter phase. It is part of the required shape: a
    // missing field never defaults to a success reading.
    const filterDecisionValidRaw = groupRaw.filter_decision_valid;
    let filterDecisionValid: boolean | null = null;
    if (filterDecisionValidRaw === undefined) {
      issues.push({
        code: 'outcome_filter_decision_valid_invalid',
        detail: field('filter_decision_valid'),
      });
    } else if (
      filterDecisionValidRaw !== null &&
      typeof filterDecisionValidRaw !== 'boolean'
    ) {
      issues.push({
        code: 'outcome_filter_decision_valid_invalid',
        detail: field('filter_decision_valid'),
      });
    } else if (filterDecisionValidRaw !== null) {
      filterDecisionValid = filterDecisionValidRaw;
    }
    if (plan === null || compression === null || relocation === null || filter === null) {
      return violation();
    }

    // §7.4 consistency cross-checks: contradiction is a contract failure.
    if (mainCompleted && stopCause !== null) {
      issues.push({
        code: 'outcome_main_completed_contradiction',
        detail: field('main_completed'),
      });
    }
    if (mainCompleted && completed === 0) {
      issues.push({
        code: 'outcome_main_completed_contradiction',
        detail: field('rounds.completed'),
      });
    }
    if (!mainCompleted && stopCause === null) {
      issues.push({
        code: 'outcome_main_incomplete_without_stop',
        detail: field('stop_cause'),
      });
    }
    if (filter.state === 'completed' && filterDecisionValid !== true) {
      issues.push({
        code: 'outcome_filter_decision_contradiction',
        detail: field('filter_decision_valid'),
      });
    }
    if (
      filterDecisionValid === false &&
      filter.state !== 'failed' &&
      filter.state !== 'cancelled'
    ) {
      issues.push({
        code: 'outcome_filter_decision_contradiction',
        detail: field('filter_decision_valid'),
      });
    }
    if (filter.state === 'not_applicable' && filterDecisionValid !== null) {
      issues.push({
        code: 'outcome_filter_decision_contradiction',
        detail: field('filter_decision_valid'),
      });
    }

    return Object.freeze({
      paths: Object.freeze(paths),
      mainCompleted,
      stopCause,
      rounds: Object.freeze({ configured, started, completed }),
      phases: Object.freeze({ plan, compression, relocation, filter }),
      filterDecisionValid,
    });
  });

  if (issues.length > 0) return violation();
  return Object.freeze({
    schemaVersion: OCR_OUTCOME_SCHEMA_VERSION,
    runStopCause,
    grouping: Object.freeze({ state: groupingState, reason: groupingReason }),
    groups: Object.freeze(groups),
  });
}

/** Bounded local diagnostic codes for §8.2 coverage/quality mapping. */
export const OCR_OUTCOME_DIAGNOSTIC_REASONS = [
  'missing_required_main',
  'late_round_stop',
  'review_limit',
  'missing_paths',
  'phase_failed',
  'invalid_filter_decision',
  'grouping_fallback',
] as const;

export type OcrOutcomeDiagnosticReason =
  (typeof OCR_OUTCOME_DIAGNOSTIC_REASONS)[number];

export type OcrOutcomeClassification = Readonly<{
  /** Bounded local diagnostic codes; never new wire keys. */
  reasons: readonly OcrOutcomeDiagnosticReason[];
  /** Degraded/partial engine outcome: needs partial quality flags (§8.2). */
  partial: boolean;
  /** The only degradation is an invalid filter decision that preserved the
   * comments (§7.3): inspection and path coverage are intact, so this needs
   * just the advisory provider_warning, never context_inspection_incomplete. */
  filterCommentsPreserved: boolean;
}>;

const STOP_CAUSE_REASONS: Readonly<
  Record<OcrRunStopCause, OcrOutcomeDiagnosticReason>
> = {
  max_rounds: 'review_limit',
  empty_rounds: 'missing_required_main',
  compression: 'phase_failed',
  token_budget: 'late_round_stop',
  prompt_budget: 'late_round_stop',
  provider_error: 'missing_required_main',
  input_error: 'missing_required_main',
  internal_error: 'missing_required_main',
  cancelled: 'missing_required_main',
  deadline: 'missing_required_main',
};

/**
 * §8.2 mapping invariant: every degraded/partial outcome yields reasons and
 * `partial=true`; natural not_applicable skips do not flag.
 */
export function classifyOcrReviewOutcome(
  outcome: OcrReviewOutcome
): OcrOutcomeClassification {
  const reasons = new Set<OcrOutcomeDiagnosticReason>();
  let filterCommentsPreserved = true;
  if (outcome.runStopCause !== null) {
    reasons.add(STOP_CAUSE_REASONS[outcome.runStopCause]);
    filterCommentsPreserved = false;
  }
  if (outcome.grouping.state === 'failed' || outcome.grouping.state === 'cancelled') {
    reasons.add('grouping_fallback');
    filterCommentsPreserved = false;
  }
  for (const group of outcome.groups) {
    if (!group.mainCompleted) {
      reasons.add(
        group.stopCause !== null
          ? STOP_CAUSE_REASONS[group.stopCause]
          : 'missing_required_main'
      );
      filterCommentsPreserved = false;
    }
    const [plan, compression, relocation] = [
      group.phases.plan,
      group.phases.compression,
      group.phases.relocation,
    ];
    const filter = group.phases.filter;
    const nonFilterFailed = [plan, compression, relocation].some(
      (phase) => phase.state === 'failed' || phase.state === 'cancelled'
    );
    const filterFailed =
      filter.state === 'failed' || filter.state === 'cancelled';
    if (nonFilterFailed || filterFailed) {
      reasons.add('phase_failed');
    }
    if (nonFilterFailed) {
      filterCommentsPreserved = false;
    } else if (filterFailed && group.filterDecisionValid !== false) {
      // The engine documents "preserved comments" (§7.3) only for the
      // malformed-decision case (filter_decision_valid === false). A failed
      // filter without that proof keeps the full flag pair.
      filterCommentsPreserved = false;
    }
    if (group.filterDecisionValid === false) {
      reasons.add('invalid_filter_decision');
    }
    if (group.rounds.completed < group.rounds.started) {
      reasons.add('late_round_stop');
      filterCommentsPreserved = false;
    }
  }
  return Object.freeze({
    reasons: Object.freeze([...reasons].sort()),
    partial: reasons.size > 0,
    filterCommentsPreserved: filterCommentsPreserved && reasons.size > 0,
  });
}

/* ------------------------------------------------------------------ */
/* Native managed review result (jsonOutput + reviewrouter_outcome)     */
/* ------------------------------------------------------------------ */

export type OcrNativeComment = Readonly<{
  path: string;
  content: string;
  suggestionCode: string | null;
  existingCode: string | null;
  startLine: number | null;
  endLine: number | null;
  category: string | null;
  severity: string | null;
}>;

export type OcrNativeManifest = Readonly<{
  schemaVersion: string;
  operation: string;
  terminalState: string | null;
  input: Readonly<{
    mode: string;
    resolvedBase: string | null;
    resolvedHead: string | null;
  }>;
}>;

export type OcrNativeReviewResult = Readonly<{
  status: string | null;
  /** Requested identity only; observed actualModel comes from the bridge. */
  requestedModel: string | null;
  usage: Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  }>;
  budgetExceeded: boolean;
  comments: readonly OcrNativeComment[];
  warnings: readonly string[];
  manifest: OcrNativeManifest;
  outcome: OcrReviewOutcome;
}>;

export type OcrNativeManifestAdmission = Readonly<{
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
}>;

function optionalInt(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sameSha(observed: unknown, expected: string): boolean {
  return (
    typeof observed === 'string' &&
    observed.toLowerCase() === expected.toLowerCase()
  );
}

/**
 * Parse one full native managed review JSON object: native jsonOutput fields
 * plus the required §7.4 `reviewrouter_outcome` extension. Throws
 * OcrNativeResultContractViolation on structural corruption, missing managed
 * extension, unknown required values, or manifest/ref mismatch. Field-level
 * finding quality problems are left to normalization (§8.2 skip rules).
 */
export function parseOcrNativeReviewResult(
  raw: unknown,
  admission: OcrNativeManifestAdmission
): OcrNativeReviewResult {
  const issues: OcrContractIssue[] = [];
  const violation = (): never => {
    throw new OcrNativeResultContractViolation(issues);
  };
  if (!isRecord(raw)) {
    issues.push({ code: 'native_result_not_an_object', detail: 'result' });
    return violation();
  }

  // Native manifest checks (§7.4 rule 7, §8.4 step 4).
  const manifestRaw = raw.manifest;
  if (!isRecord(manifestRaw)) {
    issues.push({ code: 'native_manifest_missing', detail: 'manifest' });
    return violation();
  }
  const manifestInput = isRecord(manifestRaw.input) ? manifestRaw.input : null;
  if (manifestInput === null) {
    issues.push({ code: 'native_manifest_input_missing', detail: 'manifest.input' });
    return violation();
  }
  const manifest: OcrNativeManifest = Object.freeze({
    schemaVersion: typeof manifestRaw.schema_version === 'string' ? manifestRaw.schema_version : '',
    operation: typeof manifestRaw.operation === 'string' ? manifestRaw.operation : '',
    terminalState: optionalText(manifestRaw.terminal_state),
    input: Object.freeze({
      mode: typeof manifestInput.mode === 'string' ? manifestInput.mode : '',
      resolvedBase: optionalText(manifestInput.resolved_base),
      resolvedHead: optionalText(manifestInput.resolved_head),
    }),
  });
  if (manifest.schemaVersion !== 'ocr.run-manifest/v1') {
    issues.push({ code: 'native_manifest_schema_version', detail: manifest.schemaVersion });
  }
  if (manifest.operation !== 'review') {
    issues.push({ code: 'native_manifest_operation', detail: manifest.operation });
  }
  if (manifest.input.mode !== 'range') {
    issues.push({ code: 'native_manifest_mode', detail: manifest.input.mode });
  }
  if (!sameSha(manifest.input.resolvedBase, admission.mergeBaseSha)) {
    issues.push({ code: 'native_manifest_refs_mismatch', detail: 'resolved_base' });
  }
  if (!sameSha(manifest.input.resolvedHead, admission.headSha)) {
    issues.push({ code: 'native_manifest_refs_mismatch', detail: 'resolved_head' });
  }

  // Managed extension: required; missing/unknown/contradictory is a contract
  // failure and never a "success default".
  const outcomeRaw = raw.reviewrouter_outcome;
  if (outcomeRaw === undefined || outcomeRaw === null) {
    issues.push({ code: 'managed_outcome_missing', detail: 'reviewrouter_outcome' });
    return violation();
  }
  let outcome: OcrReviewOutcome;
  try {
    outcome = parseOcrReviewOutcome(outcomeRaw);
  } catch (error) {
    if (error instanceof OcrManagedContractViolation) {
      issues.push(...error.issues);
      return violation();
    }
    throw error;
  }

  const llmRaw = isRecord(raw.llm) ? raw.llm : null;
  const summaryRaw = isRecord(raw.summary) ? raw.summary : null;
  const usage = Object.freeze({
    inputTokens: summaryRaw ? optionalInt(summaryRaw.input_tokens) : null,
    outputTokens: summaryRaw ? optionalInt(summaryRaw.output_tokens) : null,
    totalTokens: summaryRaw ? optionalInt(summaryRaw.total_tokens) : null,
  });

  const comments: OcrNativeComment[] = [];
  const commentsRaw = raw.comments;
  if (commentsRaw !== undefined && commentsRaw !== null) {
    if (!Array.isArray(commentsRaw)) {
      issues.push({ code: 'native_comments_invalid', detail: 'comments' });
    } else {
      commentsRaw.forEach((comment, index) => {
        if (!isRecord(comment)) {
          issues.push({
            code: 'native_comment_invalid',
            detail: `comments[${index}]`,
          });
          return;
        }
        comments.push(
          Object.freeze({
            path: typeof comment.path === 'string' ? comment.path : '',
            content: typeof comment.content === 'string' ? comment.content : '',
            suggestionCode: optionalText(comment.suggestion_code),
            existingCode: optionalText(comment.existing_code),
            startLine: optionalInt(comment.start_line),
            endLine: optionalInt(comment.end_line),
            category: optionalText(comment.category),
            severity: optionalText(comment.severity),
            // Native thinking is intentionally never captured (§8.2).
          })
        );
      });
    }
  }

  const warnings: string[] = [];
  const warningsRaw = raw.warnings;
  if (Array.isArray(warningsRaw)) {
    for (const warning of warningsRaw) {
      // Native warnings are either plain strings or {file, message, type}
      // records; only the bounded message text is carried forward.
      if (typeof warning === 'string') {
        warnings.push(warning);
      } else if (isRecord(warning) && typeof warning.message === 'string') {
        warnings.push(warning.message);
      }
    }
  }

  if (issues.length > 0) return violation();
  return Object.freeze({
    status: optionalText(raw.status),
    requestedModel: llmRaw ? optionalText(llmRaw.model) : null,
    usage,
    budgetExceeded:
      summaryRaw && typeof summaryRaw.budget_exceeded === 'boolean'
        ? summaryRaw.budget_exceeded
        : false,
    comments: Object.freeze(comments),
    warnings: Object.freeze(warnings),
    manifest,
    outcome,
  });
}
