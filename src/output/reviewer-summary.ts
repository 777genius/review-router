import { Finding, PRContext, Review, ReviewMetrics, Severity } from '../types';
import { isLinkedCurrentFinding } from '../analysis/thread-lifecycle';
import { coverageManifestFileStatusRank } from '../review-projection/domain';
import { renderReviewBanner, reviewPresentationHeading } from './review-banner';
import type { ReviewPresentation } from '../review-projection/domain/review-presentation';
import { countMaxConsecutiveBackticks } from '../utils/suggestion-formatter';

export const REVIEW_SUMMARY_STATUS_COMPLETE_MARKER =
  '<!-- reviewrouter:review-status:complete -->';
export const REVIEW_SUMMARY_STATUS_INCOMPLETE_MARKER =
  '<!-- reviewrouter:review-status:incomplete -->';

const statusHeadingMarker = '<!-- reviewrouter:summary-status -->';
// Keep the final posted comment under 60KB after publisher markers/metadata.
const maxSummaryBytes = 59_000;
const maxCoverageFileLines = 100;

export type ReviewerSummaryLocale =
  | 'en'
  | 'ru'
  | 'uk'
  | 'es'
  | 'pt'
  | 'fr'
  | 'de'
  | 'it'
  | 'zh'
  | 'ja'
  | 'ko';

export type ReviewIncompleteCauseCode =
  | 'attempt_budget_exhausted'
  | 'not_runnable'
  | 'provider_lane_busy'
  | 'investigation_deferred'
  | 'restored_terminal'
  | 'deadline_reached'
  | 'admission_limited';

type ReviewerSummaryCopy = {
  readonly noFindingsHeading: string;
  readonly limitedNoFindingsHeading: string;
  readonly dismissedNote: (count: number) => string;
  readonly findingsHeading: (input: SeverityCounts) => string;
  readonly providerFailures: (failed: number, planned: number) => string;
  readonly incompleteCauseHeading: string;
  readonly incompleteCauses: Readonly<
    Record<ReviewIncompleteCauseCode, string>
  >;
  readonly location: string;
  readonly fix: string;
  readonly incompleteHeading: (count: number) => string;
  readonly incompleteNote: string;
  readonly coverageHeading: string;
  readonly manifestHeading: string;
  readonly moreFiles: (count: number) => string;
  readonly moreFindings: (count: number) => string;
  readonly lifecycle: {
    readonly resolved: string;
    readonly active: string;
    readonly carried: string;
    readonly uncertain: string;
    readonly suppressed: string;
  };
};

type SeverityCounts = {
  readonly total: number;
  readonly critical: number;
  readonly major: number;
  readonly minor: number;
};

export type ReviewerSummaryFinding = {
  /** Display-only classification supplied by the occurrence projection. */
  readonly previous?: boolean;
  /** Stable occurrence identity, when available; never inferred from prose. */
  readonly lineageId?: string;
  readonly severity: Severity;
  readonly title: string;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly suggestion?: string;
  readonly category?: string;
  readonly evidence?: Finding['evidence'];
  readonly attribution?: readonly string[];
  readonly attributionPoolSize?: number;
};

export type ReviewerLifecycleLine = {
  readonly lineageId?: string;
  readonly kind: 'resolved' | 'active' | 'carried' | 'uncertain' | 'suppressed';
  readonly title: string;
  readonly message: string;
  readonly locationLabel: string;
};

export function resolveReviewerSummaryLocale(
  language: string | undefined
): ReviewerSummaryLocale {
  const normalized = language?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return 'en';
  }
  if (
    normalized === 'en' ||
    normalized.startsWith('en-') ||
    normalized === 'english'
  ) {
    return 'en';
  }
  if (
    normalized.startsWith('ru') ||
    normalized.includes('рус') ||
    normalized === 'russian'
  ) {
    return 'ru';
  }
  if (
    normalized.startsWith('uk') ||
    normalized.includes('укр') ||
    normalized === 'ukrainian'
  ) {
    return 'uk';
  }
  if (
    normalized.startsWith('es') ||
    normalized === 'spanish' ||
    normalized.includes('español')
  ) {
    return 'es';
  }
  if (
    normalized.startsWith('pt') ||
    normalized === 'portuguese' ||
    normalized.includes('portugu')
  ) {
    return 'pt';
  }
  if (
    normalized.startsWith('fr') ||
    normalized === 'french' ||
    normalized.includes('français')
  ) {
    return 'fr';
  }
  if (
    normalized.startsWith('de') ||
    normalized === 'german' ||
    normalized.includes('deutsch')
  ) {
    return 'de';
  }
  if (
    normalized.startsWith('it') ||
    normalized === 'italian' ||
    normalized.includes('italiano')
  ) {
    return 'it';
  }
  if (
    normalized.startsWith('zh') ||
    normalized === 'chinese' ||
    normalized.includes('中文') ||
    normalized.includes('汉语') ||
    normalized.includes('漢語')
  ) {
    return 'zh';
  }
  if (
    normalized.startsWith('ja') ||
    normalized === 'japanese' ||
    normalized.includes('日本')
  ) {
    return 'ja';
  }
  if (
    normalized.startsWith('ko') ||
    normalized === 'korean' ||
    normalized.includes('한국') ||
    normalized.includes('조선')
  ) {
    return 'ko';
  }
  return 'en';
}

export function reviewerSummaryCopy(
  language: string | undefined
): ReviewerSummaryCopy {
  return copies[resolveReviewerSummaryLocale(language)];
}

export function limitReviewerPostedMarkdown(
  value: string,
  maxChars = 65_000
): string {
  return limitUtf8(value, Math.min(maxSummaryBytes, maxChars));
}

export function neutralizeDetailsMarkup(value: string): string {
  return value.replace(/<\/?(?:details|summary)\b[^>]*>/gi, (tag) =>
    tag.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  );
}

export type ReviewerSummaryOptions = {
  /** Trusted SCM metadata, never model output. Links always use the reviewed revision. */
  readonly source?: NonNullable<Review['sourceRevision']>;
  /** Trusted public origin; absent by default. Publication never fetches the image. */
  readonly bannerBaseUrl?: string;
};

/** Reuse trusted target metadata without assigning links to deleted/unknown head paths. */
export function reviewerSummarySourceFromPr(
  pr: PRContext
): Review['sourceRevision'] {
  if (!pr.sourceRepositoryUrl) return undefined;
  return {
    repositoryHtmlUrl: pr.sourceRepositoryUrl,
    headSha: pr.headSha,
    availablePaths: pr.files
      .filter((file) => file.status !== 'removed')
      .map((file) => file.filename),
  };
}

export type ReviewerSummaryInput = ReviewerSummaryOptions & {
  readonly reviewPresentation?: ReviewPresentation;
  readonly language: string | undefined;
  readonly findings: readonly ReviewerSummaryFinding[];
  readonly metrics: Pick<
    ReviewMetrics,
    | 'totalFindings'
    | 'critical'
    | 'major'
    | 'minor'
    | 'providersUsed'
    | 'providersSuccess'
  >;
  readonly incomplete?: boolean;
  readonly incompleteCauses?: readonly string[];
  readonly coverage?: {
    readonly complete: boolean;
    readonly totalFiles: number;
    readonly reviewedFiles: number;
    readonly unreviewedFiles: number;
    readonly mode: string;
    readonly limitations: readonly string[];
    readonly fullDiffFiles?: number;
    readonly compactedFiles?: number;
    readonly metadataOnlyFiles?: number;
    readonly skippedFiles?: number;
    readonly agenticContext?: boolean;
    readonly files?: readonly {
      readonly path: string;
      readonly status: string;
      readonly reason?: string;
    }[];
  };
  readonly lifecycle?: readonly ReviewerLifecycleLine[];
  readonly lifecycleAttention?: boolean;
  readonly lifecycleWarnings?: readonly string[];
  readonly previousCounts?: Readonly<Record<Severity, number>>;
  readonly dismissedFindings?: number;
  // These are actual optional measurements, never derived from planned counts.
  readonly measurements?: {
    readonly durationSeconds?: number;
    readonly tokens?: number;
    readonly cost?: number;
    readonly cacheHit?: boolean;
    readonly providers?: NonNullable<Review['runDetails']>['providers'];
  };
  readonly analysis?: Review['aiAnalysis'];
  readonly diagram?: string;
  readonly testHints?: Review['testHints'];
};

export function isReviewerSummaryIncomplete(input: {
  readonly reviewPresentation?: ReviewPresentation;
  readonly incomplete?: boolean;
  readonly coverage?: { readonly complete: boolean };
  readonly metrics: Pick<ReviewMetrics, 'providersUsed' | 'providersSuccess'>;
}): boolean {
  return (
    input.incomplete === true ||
    input.reviewPresentation?.state === 'incomplete' ||
    input.coverage?.complete === false ||
    (input.metrics.providersUsed > 0 && input.metrics.providersSuccess === 0)
  );
}

export function renderReviewerSummaryMarkdown(
  input: ReviewerSummaryInput
): string {
  const locale = resolveReviewerSummaryLocale(input.language);
  const copy = reviewerSummaryCopy(input.language);
  const labels = sectionCopy[locale];
  const counts: SeverityCounts = {
    total: input.reviewPresentation
      ? Object.values(input.reviewPresentation.severity).reduce(
          (sum, value) => sum + value,
          0
        )
      : input.metrics.totalFindings,
    critical:
      input.reviewPresentation?.severity.critical ?? input.metrics.critical,
    major: input.reviewPresentation?.severity.major ?? input.metrics.major,
    minor: input.reviewPresentation?.severity.minor ?? input.metrics.minor,
  };
  const previous = input.reviewPresentation ? undefined : input.previousCounts;
  const historical =
    (input.lifecycle?.length ?? 0) > 0 || input.lifecycleAttention;
  const incomplete = isReviewerSummaryIncomplete(input);
  const limitedScope =
    input.coverage &&
    (input.coverage.unreviewedFiles > 0 ||
      (input.coverage.compactedFiles ?? 0) > 0 ||
      (input.coverage.metadataOnlyFiles ?? 0) > 0 ||
      (input.coverage.skippedFiles ?? 0) > 0 ||
      input.coverage.limitations.length > 0);
  const severityLine = (['critical', 'major', 'minor'] as const)
    .map((severity, i) => {
      const count = counts[severity] + (previous?.[severity] ?? 0);
      return count > 0
        ? `${['🔴', '🟡', '🔵'][i]} **${count} ${severity}**`
        : '';
    })
    .filter(Boolean)
    .join(' · ');
  const heading =
    (input.reviewPresentation
      ? reviewPresentationHeading(input.reviewPresentation)
      : '') ||
    (incomplete
      ? copy.incompleteHeading(counts.total)
      : severityLine ||
        (counts.total > 0
          ? copy.findingsHeading(counts)
          : historical
            ? `## ${labels.previous}`
            : input.dismissedFindings
              ? `## ${labels.dismissed}`
              : limitedScope
                ? copy.limitedNoFindingsHeading
                : copy.noFindingsHeading));
  const lines = [
    incomplete
      ? REVIEW_SUMMARY_STATUS_INCOMPLETE_MARKER
      : REVIEW_SUMMARY_STATUS_COMPLETE_MARKER,
    `<!-- reviewrouter:summary-locale:${locale} -->`,
    statusHeadingMarker,
    heading,
  ];
  if (incomplete) lines.push('', copy.incompleteNote);
  const incompleteCauseCodes = (input.incompleteCauses ?? []).filter(
    (code): code is ReviewIncompleteCauseCode =>
      Object.hasOwn(copy.incompleteCauses, code)
  );
  if (incomplete && incompleteCauseCodes.length > 0) {
    lines.push('', copy.incompleteCauseHeading);
    for (const code of incompleteCauseCodes) {
      lines.push(`- ${copy.incompleteCauses[code]}`);
    }
  }
  if (incomplete && severityLine) lines.push('', severityLine);
  const chrome = compactCopy[locale];
  const banner = renderReviewerBanner(input, incomplete, counts);
  if (banner) lines.push('', banner);
  let omitted = false;
  // Allocate before optional bodies: state and actionable warnings can never be
  // displaced by an oversized finding, evidence, manifest, or provider trace.
  const pushWarning = (value: string) => {
    if (utf8Bytes([...lines, '', value].join('\n')) <= 12_000)
      lines.push('', value);
    else omitted = true;
  };
  const failed = Math.max(
    0,
    input.metrics.providersUsed - input.metrics.providersSuccess
  );
  if (failed > 0)
    lines.push('', copy.providerFailures(failed, input.metrics.providersUsed));
  if (input.dismissedFindings)
    lines.push(
      '',
      `${labels.dismissed}: ${input.dismissedFindings}`,
      '',
      copy.dismissedNote(input.dismissedFindings)
    );
  if (limitedScope && input.coverage) {
    lines.push(
      '',
      `**${labels.scope}: ${input.coverage.reviewedFiles}/${input.coverage.totalFiles} · ${labels.unreviewed}: ${input.coverage.unreviewedFiles}**`
    );
    for (const warning of input.coverage.limitations
      .filter((value) => !isRawLimitationToken(value))
      .slice(0, 3))
      pushWarning(escapeMarkdownText(warning));
  }
  if (input.lifecycleAttention) {
    lines.push('', `**${labels.attention}**`);
    for (const warning of input.lifecycleWarnings ?? [])
      pushWarning(escapeMarkdownText(warning));
  }
  const detailedLineages = new Set(
    input.findings.flatMap((finding) =>
      finding.lineageId ? [finding.lineageId] : []
    )
  );
  const history = (input.lifecycle ?? []).filter(
    (line) => !line.lineageId || !detailedLineages.has(line.lineageId)
  );
  const lifecycleGroups = [
    history.filter((line) => line.kind === 'active'),
    history.filter(
      (line) => line.kind === 'uncertain' || line.kind === 'carried'
    ),
  ];
  const historyLines: string[][] = [[], []];
  for (const [index, group] of lifecycleGroups.entries()) {
    if (!group.length) continue;
    for (const line of group) {
      const overview = `- ${index === 0 ? `**${copy.lifecycle[line.kind]}** · ` : ''}${escapeMarkdownText(compactFindingPresentation(line, locale).title)} · ${escapeCoverageManifestPath(line.locationLabel)}`;
      if (utf8Bytes([...historyLines.flat(), overview].join('\n')) <= 12_000)
        historyLines[index].push(overview);
      else omitted = true;
    }
  }
  const diagnostics: string[] = [];
  const warningLines = lines.splice(0);
  if (input.coverage) {
    const coverage = input.coverage;
    diagnostics.push(
      '',
      `### ${labels.scope}`,
      '',
      `| ${labels.metric} | ${labels.value} |`,
      '|---|---:|',
      `| ${labels.files} | ${coverage.reviewedFiles}/${coverage.totalFiles} |`,
      `| ${labels.unreviewed} | ${coverage.unreviewedFiles} |`,
      `| ${labels.mode} | ${escapeMarkdownText(coverage.mode)} |`
    );
    const excludedFiles = [
      coverage.totalFiles,
      coverage.reviewedFiles,
      coverage.unreviewedFiles,
    ].every((count) => Number.isSafeInteger(count) && count >= 0)
      ? coverage.totalFiles - coverage.reviewedFiles - coverage.unreviewedFiles
      : 0;
    // Incremental totals also contain unchanged files outside this update.
    if (
      coverage.mode === 'full' &&
      Number.isSafeInteger(excludedFiles) &&
      excludedFiles > 0
    ) {
      diagnostics.push(
        `| ${scopeCopy[locale].excludedByPolicy} | ${excludedFiles} |`
      );
    }

    for (const [key, value] of [
      ['fullDiff', coverage.fullDiffFiles],
      ['compacted', coverage.compactedFiles],
      ['metadataOnly', coverage.metadataOnlyFiles],
      ['skipped', coverage.skippedFiles],
    ] as const) {
      if (value !== undefined)
        diagnostics.push(`| ${scopeCopy[locale][key]} | ${value} |`);
    }
    if (coverage.agenticContext !== undefined)
      diagnostics.push(
        `| ${scopeCopy[locale].context} | ${coverage.agenticContext ? '✓' : '—'} |`
      );
    diagnostics.push('');
    if (!coverage.complete) diagnostics.push(copy.coverageHeading, '');
    diagnostics.push(
      ...coverage.limitations
        .filter((value) => !isRawLimitationToken(value))
        .map((value) => `- ${escapeMarkdownText(value)}`)
    );
    const manifestFiles = incomplete
      ? [...(coverage.files ?? [])].sort(compareCoverageManifestFiles)
      : (coverage.files ?? []).filter((file) => file.status !== 'full');
    const manifestLines: string[] = [];
    for (const file of manifestFiles.slice(0, maxCoverageFileLines)) {
      const line = `- ${escapeCoverageManifestPath(file.path)} - ${escapeMarkdownText(file.status)}${file.reason ? ` — ${escapeMarkdownText(file.reason)}` : ''}`;
      // Budget every manifest line against the whole summary so the final byte
      // cap can never cut inside the coverage <details> block; a mid-block cut
      // would drop the counts, limitations, and manifest together.
      const projected = [
        ...(incomplete && manifestLines.length === 0
          ? [copy.manifestHeading, '']
          : []),
        ...manifestLines,
        line,
        '',
        copy.moreFiles(manifestFiles.length - manifestLines.length),
      ];
      if (utf8Bytes(projected.join('\n')) > 16_000) {
        break;
      }
      manifestLines.push(line);
    }
    if (incomplete && manifestFiles.length > 0)
      diagnostics.push(copy.manifestHeading, '');
    diagnostics.push(...manifestLines);
    const hiddenFiles = manifestFiles.length - manifestLines.length;
    if (hiddenFiles > 0) diagnostics.push('', copy.moreFiles(hiddenFiles));
  }
  if (history.length)
    diagnostics.push(
      '',
      `### ${labels.previous}`,
      '',
      ...history.map(
        (line) =>
          `- ${line.kind === 'uncertain' || line.kind === 'carried' ? '' : `**${copy.lifecycle[line.kind]}** · `}${escapeMarkdownText(line.title)} · ${escapeCoverageManifestPath(line.locationLabel)}\n\n${safeFindingBody(line.message)}`
      )
    );
  const measured = input.measurements;
  diagnostics.push(
    '',
    `### ${labels.performance}`,
    '',
    `| ${labels.metric} | ${labels.value} |`,
    '|---|---:|',
    `| ${labels.providers} | ${input.metrics.providersSuccess}/${input.metrics.providersUsed} |`
  );
  if (measured?.durationSeconds !== undefined)
    diagnostics.push(
      `| ${labels.duration} | ${measured.durationSeconds.toFixed(2)}s |`
    );
  if (measured?.tokens !== undefined)
    diagnostics.push(
      `| ${labels.tokens} | ${measured.tokens.toLocaleString('en-US')} |`
    );
  if (measured?.cost !== undefined)
    diagnostics.push(`| ${labels.cost} | $${measured.cost.toFixed(4)} |`);
  else
    diagnostics.push(
      `| ${scopeCopy[locale].billing} | ${scopeCopy[locale].unknown} |`
    );
  if (measured?.cacheHit) diagnostics.push(`| ${labels.cache} | ✓ |`);
  if (measured?.providers?.length)
    diagnostics.push('', `**${scopeCopy[locale].providerPerformance}:**`);
  for (const provider of measured?.providers ?? []) {
    const facts = [
      `${provider.durationSeconds.toFixed(2)}s`,
      ...(provider.cost !== undefined && provider.cost > 0
        ? [`$${provider.cost.toFixed(4)}`]
        : []),
      ...(provider.tokens !== undefined && provider.tokens > 0
        ? [`${provider.tokens} ${labels.tokens.toLowerCase()}`]
        : []),
    ];
    const icon =
      provider.status === 'success'
        ? '✅'
        : provider.status === 'timeout'
          ? '⏱️'
          : provider.status === 'rate-limited'
            ? '⏸️'
            : '❌';
    diagnostics.push(
      '',
      `- ${icon} **${escapeMarkdownText(provider.name)}${provider.requiredHealthy ? ` (${scopeCopy[locale].required})` : ''}** (${facts.join(', ')})`
    );
    if (provider.errorMessage)
      diagnostics.push(`  ${escapeMarkdownText(provider.errorMessage)}`);
  }
  if (input.analysis) {
    const analysis = input.analysis;
    diagnostics.push(
      '',
      `### ${labels.analysis}`,
      '',
      `${(analysis.averageLikelihood * 100).toFixed(1)}% · ${escapeMarkdownText(analysis.consensus)}`,
      ...Object.entries(analysis.providerEstimates).map(
        ([name, likelihood]) =>
          `- ${escapeMarkdownText(name)}: ${(likelihood * 100).toFixed(1)}%`
      ),
      ''
    );
  }
  if (input.diagram?.trim() && /(?:-->|---|-.->|==>)/.test(input.diagram)) {
    diagnostics.push(
      '',
      `### ${labels.impact}`,
      '',
      formatCodeFence(neutralizeDetailsMarkup(input.diagram), 'mermaid'),
      ''
    );
  }
  if (input.testHints?.length)
    diagnostics.push(
      '',
      `### ${scopeCopy[locale].tests}`,
      '',
      ...input.testHints.map(
        (hint) =>
          `- ${escapeCoverageManifestPath(hint.file)} → ${escapeCoverageManifestPath(hint.suggestedTestFile)}: ${escapeMarkdownText(hint.testPattern)}`
      ),
      ''
    );
  lines.push(...warningLines);
  // Every optional append is atomic. The final notice and closing tag are reserved.
  const notice = `**${chrome.omitted}**`;
  const reserve = utf8Bytes(notice) + 500;
  const append = (block: string, budget = maxSummaryBytes): boolean => {
    if (utf8Bytes([...lines, '', block].join('\n')) + reserve > budget) {
      omitted = true;
      return false;
    }
    lines.push('', block);
    return true;
  };
  const findings = [...input.findings].sort(compareSummaryFindings);
  const newFindings = findings.filter((finding) => !finding.previous);
  const previousFindings = findings.filter((finding) => finding.previous);
  const findingBudget =
    maxSummaryBytes - 6_000 - utf8Bytes(historyLines.flat().join('\n'));
  for (const [kind, group] of [
    ['new', newFindings],
    ['rechecked', previousFindings],
  ] as const) {
    const groupCount =
      group.length + (kind === 'rechecked' ? lifecycleGroups[0].length : 0);
    if (
      groupCount ||
      (kind === 'new' && input.reviewPresentation?.variant === 'update')
    )
      append(
        `### ${findingGroupHeading(locale, kind, groupCount)}`,
        findingBudget
      );
    for (const finding of group) {
      const presentation = compactFindingPresentation(finding, locale);
      const overview = compactFindingLine(
        finding,
        presentation.title,
        input.source
      );
      const excerpt = findings.length <= 3 ? presentation.excerpt : '';
      const preview = [
        overview,
        ...(excerpt
          ? [
              '',
              escapeMarkdownText(excerpt)
                .replace(/^([#+-])/, '\\$1')
                .replace(/^(\d+)([.)])(?=\s)/, '$1\\$2'),
            ]
          : []),
      ].join('\n');
      const details = renderFindingDetails(copy, finding, chrome);
      if (!append(`${preview}\n\n${details}`, findingBudget)) {
        append(preview, findingBudget);
      }
    }
    if (kind === 'rechecked' && historyLines[0].length)
      append(historyLines[0].join('\n'));
  }
  if (historyLines[1].length)
    append(
      `### ${findingGroupHeading(locale, 'unverified', lifecycleGroups[1].length)}\n\n${historyLines[1].join('\n')}`
    );
  // Keep the diagnostic header/table even when a later large block does not fit.
  const details: string[] = [];
  for (const block of markdownBlocks(diagnostics.join('\n'))) {
    const candidate = `<details>\n<summary>${chrome.details}</summary>\n\n${[...details, block].join('\n\n')}\n\n</details>`;
    if (
      utf8Bytes([...lines, '', candidate].join('\n')) + reserve <=
      maxSummaryBytes
    )
      details.push(block);
    else omitted = true;
  }
  if (details.length)
    append(
      `<details>\n<summary>${chrome.details}</summary>\n\n${details.join('\n\n')}\n\n</details>`
    );
  if (omitted) lines.push('', notice);
  return lines.join('\n');
}

/** Legacy compatibility mapping only; presentation stays in the normalized renderer. */
export function renderReviewSummary(
  review: Review,
  language?: string,
  options: ReviewerSummaryOptions = {}
): string {
  const retainedLocale = review.summary.match(
    /<!-- reviewrouter:summary-locale:([a-z]{2}) -->/
  )?.[1];
  const retainedIncomplete = review.summary.includes(
    REVIEW_SUMMARY_STATUS_INCOMPLETE_MARKER
  );
  const lifecycle =
    review.threadLifecycle?.mode === 'off' ? undefined : review.threadLifecycle;
  const stillValid =
    lifecycle?.previousStillValid.filter(
      (record) => !isLinkedCurrentFinding(record)
    ) ?? [];
  const appliedResolutions = new Set(
    lifecycle?.resolvedByLifecycle.map((record) => record.target.targetId)
  );
  const attention = lifecycle
    ? [
        ...lifecycle.resolvedCandidates.filter(
          (record) => !appliedResolutions.has(record.target.targetId)
        ),
        ...lifecycle.previousUncertain,
        ...lifecycle.manualAttention,
        ...lifecycle.mutationSkipped,
        ...lifecycle.mutationFailed,
        ...lifecycle.skipped.filter(
          (record) =>
            !record.reasonCodes.every(
              (reason) => reason === 'command_dismissed'
            )
        ),
      ]
    : [];
  const lifecycleLines: ReviewerLifecycleLine[] = [];
  const add = (
    records: typeof stillValid,
    kind: ReviewerLifecycleLine['kind']
  ) => {
    for (const record of records)
      lifecycleLines.push({
        kind,
        title: record.target.title,
        message: [
          record.target.message,
          ...record.reasonCodes.map((reason) => reason.replaceAll('_', ' ')),
        ].join('\n\n'),
        locationLabel: `${record.target.currentPath ?? record.target.originalPath}:${record.target.currentLine ?? record.target.originalLine ?? 1}`,
      });
  };
  add(stillValid, 'active');
  add(lifecycle?.resolvedByLifecycle ?? [], 'resolved');
  add(attention, 'uncertain');
  const scope = review.coverage;
  const run = review.runDetails;
  const measured =
    run !== undefined ||
    (review.providerResults?.length ?? 0) > 0 ||
    review.metrics.durationSeconds > 0 ||
    review.metrics.totalTokens > 0 ||
    review.metrics.totalCost > 0;
  return renderReviewerSummaryMarkdown({
    ...(review.sourceRevision ? { source: review.sourceRevision } : {}),
    ...options,
    language: language ?? retainedLocale,
    findings: review.findings.map(toReviewerSummaryFinding),
    metrics: review.metrics,
    incomplete: retainedIncomplete,
    ...(scope
      ? {
          coverage: {
            complete: scope.complete,
            totalFiles: scope.totalFiles,
            reviewedFiles: scope.filesConsidered,
            unreviewedFiles: scope.unreviewedFiles,
            mode: scope.mode,
            limitations: scope.limitations ?? [],
            fullDiffFiles: scope.fullDiffFiles,
            compactedFiles: scope.compactedFiles,
            metadataOnlyFiles: scope.metadataOnlyFiles,
            skippedFiles: scope.skippedFiles,
            agenticContext: scope.agenticContext,
            files: scope.files,
          },
        }
      : {}),
    lifecycle: lifecycleLines,
    lifecycleWarnings: [
      ...(lifecycle?.warnings ?? []),
      ...(lifecycle?.inventoryFailed
        ? [
            sectionCopy[
              resolveReviewerSummaryLocale(language ?? retainedLocale)
            ].attention,
          ]
        : []),
    ],
    lifecycleAttention:
      attention.length > 0 ||
      lifecycle?.inventoryFailed === true ||
      (lifecycle?.warnings.length ?? 0) > 0,
    previousCounts: {
      critical: stillValid.filter(
        (record) => record.target.severity === 'critical'
      ).length,
      major: stillValid.filter((record) => record.target.severity === 'major')
        .length,
      minor: stillValid.filter((record) => record.target.severity === 'minor')
        .length,
    },
    ...(review.metrics.dismissedFindings
      ? { dismissedFindings: review.metrics.dismissedFindings }
      : {}),
    ...(measured
      ? {
          measurements: {
            ...(run ||
            (review.providerResults?.length ?? 0) > 0 ||
            review.metrics.durationSeconds > 0
              ? { durationSeconds: review.metrics.durationSeconds }
              : {}),
            ...(review.metrics.totalTokens > 0
              ? { tokens: review.metrics.totalTokens }
              : {}),
            ...(review.metrics.totalCost > 0
              ? { cost: review.metrics.totalCost }
              : {}),
            ...(run
              ? { providers: run.providers, cacheHit: run.cacheHit }
              : {}),
          },
        }
      : {}),
    ...(review.aiAnalysis ? { analysis: review.aiAnalysis } : {}),
    ...(review.mermaidDiagram ? { diagram: review.mermaidDiagram } : {}),
    ...(review.testHints ? { testHints: review.testHints } : {}),
  });
}

export function renderReviewerLifecycleMarkdown(input: {
  readonly language: string | undefined;
  readonly lines: readonly ReviewerLifecycleLine[];
}): string {
  if (input.lines.length === 0) {
    return '';
  }
  const copy = reviewerSummaryCopy(input.language);
  const blocks = input.lines.map((line) => {
    const label = copy.lifecycle[line.kind];
    const summary = escapeHtml(
      `${label} · ${line.locationLabel} · ${compactFindingPresentation(line, resolveReviewerSummaryLocale(input.language)).title}`.trim()
    );
    const body = [
      safeFindingBody(line.message.trimEnd()),
      escapeCoverageManifestPath(line.locationLabel),
    ]
      .filter(Boolean)
      .join('\n\n');
    return [
      '<details>',
      `<summary>${summary}</summary>`,
      '',
      neutralizeDetailsMarkup(body),
      '',
      '</details>',
    ].join('\n');
  });
  return limitUtf8(blocks.join('\n\n'), maxSummaryBytes);
}

export function markReviewSummaryIncomplete(input: {
  readonly summary: string;
  readonly language: string | undefined;
  readonly preliminaryFindingCount: number;
}): string {
  const copy = reviewerSummaryCopy(input.language);
  if (!input.summary.includes(REVIEW_SUMMARY_STATUS_COMPLETE_MARKER)) {
    throw new Error('legacy_partial_review_summary_contract_invalid');
  }
  const heading = copy.incompleteHeading(input.preliminaryFindingCount);
  const status = `${statusHeadingMarker}\n`;
  if (!input.summary.includes(status))
    throw new Error('legacy_partial_review_summary_contract_invalid');
  const rewritten = input.summary
    .replace(
      REVIEW_SUMMARY_STATUS_COMPLETE_MARKER,
      REVIEW_SUMMARY_STATUS_INCOMPLETE_MARKER
    )
    .replace(new RegExp(`${status}[^\\n]+`), `${status}${heading}`)
    .replace(
      /(\/review-banner\/v[12]\.svg\?state=)complete(?=&amp;|&)/g,
      '$1incomplete'
    )
    .replace('alt="Review complete"', 'alt="Review incomplete"')
    .replace('alt="Review updated"', 'alt="Review incomplete"');
  if (rewritten.includes(copy.incompleteNote)) {
    return rewritten;
  }
  return rewritten.replace(heading, `${heading}\n\n${copy.incompleteNote}`);
}

export function toReviewerSummaryFinding(
  finding: Finding
): ReviewerSummaryFinding {
  return {
    severity: finding.severity,
    title: finding.title,
    message: finding.message,
    file: finding.file,
    line: finding.line,
    ...(finding.startLine !== undefined
      ? { startLine: finding.startLine }
      : {}),
    ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
    ...(finding.category ? { category: finding.category } : {}),
    ...(finding.evidence ? { evidence: finding.evidence } : {}),
    attribution: Array.from(
      new Set([
        ...(finding.providerModels?.map((model) => model.provider) ?? []),
        ...(finding.providers ?? []),
        ...(finding.provider ? [finding.provider] : []),
      ])
    ),
    ...(finding.providerPoolSize !== undefined
      ? { attributionPoolSize: finding.providerPoolSize }
      : {}),
  };
}

export function findingLocationLabel(finding: {
  readonly file: string;
  readonly line: number;
  readonly startLine?: number;
  readonly endLine?: number;
}): string {
  if (finding.line <= 0) return finding.file;
  return finding.startLine !== undefined &&
    finding.endLine !== undefined &&
    finding.startLine < finding.endLine
    ? `${finding.file}:${finding.startLine}-${finding.endLine}`
    : `${finding.file}:${finding.line}`;
}

function renderFindingDetails(
  copy: ReviewerSummaryCopy,
  finding: ReviewerSummaryFinding,
  chrome: CompactCopy
): string {
  const parts = [
    '<details>',
    `<summary>${escapeHtml(chrome.findingDetails)}</summary>`,
    '',
    safeFindingBody(finding.message.trimEnd()),
    '',
    `**${copy.location}:** ${escapeCoverageManifestPath(findingLocationLabel(finding))}`,
  ];
  if (finding.suggestion?.trim())
    parts.push(
      '',
      `**${copy.fix}**`,
      '',
      formatCodeFence(neutralizeDetailsMarkup(finding.suggestion.trimEnd()))
    );
  if (finding.evidence)
    parts.push(
      '',
      `**${chrome.evidence}:** ${escapeMarkdownText(finding.evidence.badge)} (${Math.round(finding.evidence.confidence * 100)}%)`,
      '',
      safeFindingBody(finding.evidence.reasoning ?? '')
    );
  if (finding.attribution?.length)
    parts.push(
      '',
      finding.attribution.length === 1
        ? `<sub>${chrome.model}: ${escapeHtml(finding.attribution[0])}</sub>`
        : `<sub>${chrome.models}: ${escapeHtml(finding.attribution.join(', '))} · ${chrome.agreement} ${finding.attribution.length}/${Math.max(finding.attributionPoolSize ?? finding.attribution.length, finding.attribution.length)}</sub>`
    );
  parts.push('', '</details>');
  return parts.join('\n');
}

function compactFindingLine(
  finding: ReviewerSummaryFinding,
  title: string,
  source?: ReviewerSummaryOptions['source']
): string {
  const location = escapeCoverageManifestPath(findingLocationLabel(finding));
  const url = findingSourceUrl(finding, source);
  return `- **${finding.severity} · ${escapeMarkdownText(title)}** · ${url ? `[${location}](${url})` : location}`;
}

function findingSourceUrl(
  finding: ReviewerSummaryFinding,
  source?: ReviewerSummaryOptions['source']
): string | undefined {
  if (!source || !/^[a-f0-9]{40,64}$/i.test(source.headSha)) return undefined;
  try {
    const repo = new URL(source.repositoryHtmlUrl);
    if (
      repo.protocol !== 'https:' ||
      repo.username ||
      repo.password ||
      repo.search ||
      repo.hash ||
      !/^\/[^/]+\/[^/]+\/?$/.test(repo.pathname)
    )
      return undefined;
    if (source.availablePaths && !source.availablePaths.includes(finding.file))
      return undefined;
    if (
      !finding.file ||
      finding.file.includes('\\') ||
      hasControlCharacters(finding.file) ||
      finding.file
        .split('/')
        .some((part) => !part || part === '.' || part === '..')
    )
      return undefined;
    const path = finding.file
      .split('/')
      .map((part) =>
        encodeURIComponent(part).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
        )
      )
      .join('/');
    const hasRange =
      finding.startLine !== undefined &&
      finding.endLine !== undefined &&
      finding.startLine < finding.endLine;
    const start =
      hasRange && finding.line > 0 ? finding.startLine! : finding.line;
    const end = hasRange ? finding.endLine! : start;
    const anchor =
      Number.isSafeInteger(start) && start > 0
        ? `#L${start}${Number.isSafeInteger(end) && end > start ? `-L${end}` : ''}`
        : '';
    return `${repo.origin}${repo.pathname.replace(/\/$/, '')}/blob/${source.headSha}/${path}${anchor}`;
  } catch {
    return undefined;
  }
}

function compareSummaryFindings(
  left: ReviewerSummaryFinding,
  right: ReviewerSummaryFinding
): number {
  const rank: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };
  return (
    rank[right.severity] - rank[left.severity] ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.title.localeCompare(right.title) ||
    left.message.localeCompare(right.message)
  );
}

function formatCodeFence(content: string, language = ''): string {
  const fence = '`'.repeat(
    Math.max(3, countMaxConsecutiveBackticks(content) + 1)
  );
  return `${fence}${language}\n${content.trimEnd()}\n${fence}`;
}

function formatSeverityCounts(counts: SeverityCounts): string {
  const parts = (
    [
      ['critical', counts.critical],
      ['major', counts.major],
      ['minor', counts.minor],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`);
  return parts.length > 0 ? parts.join(', ') : '0';
}

function slavicFindingWord(
  count: number,
  forms: [string, string, string]
): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) {
    return forms[2];
  }
  if (mod10 === 1) {
    return forms[0];
  }
  if (mod10 >= 2 && mod10 <= 4) {
    return forms[1];
  }
  return forms[2];
}

function englishFindingWord(count: number): string {
  return count === 1 ? 'finding' : 'findings';
}

function findingGroupHeading(
  locale: ReviewerSummaryLocale,
  kind: 'new' | 'rechecked' | 'unverified',
  count: number
): string {
  if (locale === 'en') {
    if (kind === 'new') return `${count} new`;
    return `${count} previous ${count === 1 ? 'issue' : 'issues'} ${kind === 'rechecked' ? 'rechecked' : 'not verified'}`;
  }
  const words: Record<
    Exclude<ReviewerSummaryLocale, 'en'>,
    readonly [string, string, string]
  > = {
    ru: [
      'Новые',
      'Предыдущие замечания перепроверены',
      'Предыдущие замечания не подтверждены',
    ],
    uk: [
      'Нові',
      'Попередні зауваження перевірено повторно',
      'Попередні зауваження не підтверджено',
    ],
    es: [
      'Nuevos',
      'Problemas anteriores revisados',
      'Problemas anteriores sin verificar',
    ],
    pt: [
      'Novos',
      'Problemas anteriores revistos',
      'Problemas anteriores não verificados',
    ],
    fr: [
      'Nouveaux',
      'Problèmes précédents revérifiés',
      'Problèmes précédents non vérifiés',
    ],
    de: [
      'Neu',
      'Frühere Probleme erneut geprüft',
      'Frühere Probleme nicht bestätigt',
    ],
    it: [
      'Nuovi',
      'Problemi precedenti ricontrollati',
      'Problemi precedenti non verificati',
    ],
    zh: ['新问题', '已复查的先前问题', '未经证实的先前问题'],
    ja: ['新しい指摘', '再確認済みの過去の指摘', '未確認の過去の指摘'],
    ko: ['새 이슈', '다시 검토한 이전 이슈', '확인되지 않은 이전 이슈'],
  };
  return `${words[locale][kind === 'new' ? 0 : kind === 'rechecked' ? 1 : 2]}: ${count}`;
}

const copies: Record<ReviewerSummaryLocale, ReviewerSummaryCopy> = {
  en: {
    noFindingsHeading: '## No findings',
    limitedNoFindingsHeading: '## No reportable findings in reviewed files',
    dismissedNote: (count) =>
      `${count} ${count === 1 ? 'finding' : 'findings'} dismissed by maintainer/admin \`/rr skip\` ${count === 1 ? 'override' : 'overrides'}.`,
    findingsHeading: (counts) =>
      `## ${counts.total} ${englishFindingWord(counts.total)} (${formatSeverityCounts(counts)})`,
    incompleteCauseHeading: '**Why the review is incomplete:**',
    incompleteCauses: {
      attempt_budget_exhausted:
        'The review provider exhausted its retry attempts without returning evidence.',
      not_runnable: 'A required review unit could not be run at all.',
      provider_lane_busy:
        'The review provider stayed unavailable (busy or at capacity) for the entire run.',
      investigation_deferred:
        'A context investigation was deferred, so the review could not cover everything.',
      restored_terminal:
        'This run resumed a previous attempt that already ended without evidence.',
      deadline_reached: 'The review ran out of its execution time budget.',
      admission_limited:
        'Admission policy limited this review before it could finish.',
    },
    providerFailures: (failed, planned) =>
      `${failed} of ${planned} review providers failed.`,
    location: 'Location',
    fix: 'Fix',
    incompleteHeading: (count) =>
      `## Review incomplete — ${count} preliminary ${englishFindingWord(count)}`,
    incompleteNote:
      'Inline comments and lifecycle changes were withheld because required coverage did not complete.',
    coverageHeading: '### Coverage not completed',
    manifestHeading: '### File coverage',
    moreFiles: (count) =>
      `**${count} more ${count === 1 ? 'file' : 'files'} not shown.**`,
    moreFindings: (count) =>
      `**${count} more ${englishFindingWord(count)} omitted from this summary because of size limits.**`,
    lifecycle: {
      resolved: 'resolved',
      active: 'still valid',
      carried: 'carried, not revalidated',
      uncertain: 'needs attention',
      suppressed: 'suppressed',
    },
  },
  ru: {
    noFindingsHeading: '## Замечаний нет',
    limitedNoFindingsHeading: '## В проверенных файлах замечаний нет',
    dismissedNote: (count) =>
      `Замечаний отклонено: ${count}. Причина — команда \`/rr skip\` сопровождающего или администратора.`,
    findingsHeading: (counts) =>
      `## ${counts.total} ${slavicFindingWord(counts.total, ['замечание', 'замечания', 'замечаний'])} (${formatSeverityCounts(counts)})`,
    incompleteCauseHeading: '**Почему ревью не завершено:**',
    incompleteCauses: {
      attempt_budget_exhausted:
        'Провайдер ревью исчерпал попытки, не получив результатов.',
      not_runnable: 'Обязательный блок ревью не удалось запустить вообще.',
      provider_lane_busy:
        'Провайдер ревью был недоступен (занят или на пределе мощности) весь запуск.',
      investigation_deferred:
        'Расследование контекста было отложено, поэтому ревью не смогло покрыть всё.',
      restored_terminal:
        'Этот запуск продолжил предыдущую попытку, уже завершившуюся без результатов.',
      deadline_reached: 'У ревью закончился временной бюджет выполнения.',
      admission_limited:
        'Политика допуска ограничила это ревью до его завершения.',
    },
    providerFailures: (failed, planned) =>
      `Не сработали ${failed} из ${planned} провайдеров ревью.`,
    location: 'Место',
    fix: 'Исправление',
    incompleteHeading: (count) =>
      `## Ревью не завершено — ${count} ${slavicFindingWord(count, ['предварительное замечание', 'предварительных замечания', 'предварительных замечаний'])}`,
    incompleteNote:
      'Инлайн-комментарии и изменения lifecycle не публиковались: покрытие ревью не завершено.',
    coverageHeading: '### Покрытие не завершено',
    manifestHeading: '### Покрытие файлов',
    moreFiles: (count) =>
      `**Ещё ${count} ${slavicFindingWord(count, ['файл', 'файла', 'файлов'])} не показано.**`,
    moreFindings: (count) =>
      `**Ещё ${count} ${slavicFindingWord(count, ['замечание', 'замечания', 'замечаний'])} не влезли в это сообщение из‑за лимита размера.**`,
    lifecycle: {
      resolved: 'снято',
      active: 'остаётся актуальным',
      carried: 'перенесено, не перепроверено',
      uncertain: 'нужно внимание',
      suppressed: 'скрыто',
    },
  },
  uk: {
    noFindingsHeading: '## Зауважень немає',
    limitedNoFindingsHeading: '## У перевірених файлах зауважень немає',
    dismissedNote: (count) =>
      `Відхилено зауважень: ${count}. Причина — команда \`/rr skip\` супроводжувача або адміністратора.`,
    findingsHeading: (counts) =>
      `## ${counts.total} ${slavicFindingWord(counts.total, ['зауваження', 'зауваження', 'зауважень'])} (${formatSeverityCounts(counts)})`,
    incompleteCauseHeading: "**Чому рев'ю не завершено:**",
    incompleteCauses: {
      attempt_budget_exhausted:
        "Провайдер рев'ю вичерпав спроби, не отримавши результатів.",
      not_runnable: "Обов'язковий блок рев'ю не вдалося запустити взагалі.",
      provider_lane_busy:
        "Провайдер рев'ю був недоступний (зайнятий або на межі потужності) весь запуск.",
      investigation_deferred:
        "Дослідження контексту було відкладено, тому рев'ю не змогло охопити все.",
      restored_terminal:
        'Цей запуск продовжив попередню спробу, яка вже завершилася без результатів.',
      deadline_reached: "У рев'ю закінчився часовий бюджет виконання.",
      admission_limited:
        "Політика допуску обмежила це рев'ю до його завершення.",
    },
    providerFailures: (failed, planned) =>
      `Не спрацювали ${failed} з ${planned} провайдерів рев’ю.`,
    location: 'Місце',
    fix: 'Виправлення',
    incompleteHeading: (count) =>
      `## Рев’ю не завершено — ${count} ${slavicFindingWord(count, ['попереднє зауваження', 'попередні зауваження', 'попередніх зауважень'])}`,
    incompleteNote:
      'Інлайн-коментарі та зміни lifecycle не публікувалися: покриття рев’ю не завершено.',
    coverageHeading: '### Покриття не завершено',
    manifestHeading: '### Покриття файлів',
    moreFiles: (count) =>
      `**Ще ${count} ${slavicFindingWord(count, ['файл', 'файли', 'файлів'])} не показано.**`,
    moreFindings: (count) =>
      `**Ще ${count} ${slavicFindingWord(count, ['зауваження', 'зауваження', 'зауважень'])} не вмістилися в це повідомлення через ліміт розміру.**`,
    lifecycle: {
      resolved: 'знято',
      active: 'залишається актуальним',
      carried: 'перенесено, не перевірено знову',
      uncertain: 'потрібна увага',
      suppressed: 'приховано',
    },
  },
  es: {
    noFindingsHeading: '## Sin hallazgos',
    limitedNoFindingsHeading: '## Sin hallazgos en los archivos revisados',
    dismissedNote: (count) =>
      `${count} hallazgos descartados por la orden \`/rr skip\` de un mantenedor o administrador.`,
    findingsHeading: (counts) =>
      `## ${counts.total} ${counts.total === 1 ? 'hallazgo' : 'hallazgos'} (${formatSeverityCounts(counts)})`,
    incompleteCauseHeading: '**Por qué la revisión no está completa:**',
    incompleteCauses: {
      attempt_budget_exhausted:
        'El proveedor de revisión agotó sus intentos sin devolver evidencia.',
      not_runnable:
        'No se pudo ejecutar en absoluto una unidad de revisión obligatoria.',
      provider_lane_busy:
        'El proveedor de revisión estuvo indisponible (ocupado o al límite de capacidad) durante toda la ejecución.',
      investigation_deferred:
        'Se aplazó una investigación de contexto, así que la revisión no pudo cubrirlo todo.',
      restored_terminal:
        'Esta ejecución reanudó un intento anterior que ya había terminado sin evidencia.',
      deadline_reached:
        'La revisión agotó su presupuesto de tiempo de ejecución.',
      admission_limited:
        'La política de admisión limitó esta revisión antes de que pudiera completarse.',
    },
    providerFailures: (failed, planned) =>
      `Fallaron ${failed} de ${planned} proveedores de revisión.`,
    location: 'Ubicación',
    fix: 'Corrección',
    incompleteHeading: (count) =>
      `## Revisión incompleta — ${count} ${count === 1 ? 'hallazgo preliminar' : 'hallazgos preliminares'}`,
    incompleteNote:
      'No se publicaron comentarios en línea ni cambios de ciclo de vida porque la cobertura no se completó.',
    coverageHeading: '### Cobertura incompleta',
    manifestHeading: '### Cobertura de archivos',
    moreFiles: (count) =>
      `**${count} ${count === 1 ? 'archivo más no se muestra.' : 'archivos más no se muestran.'}**`,
    moreFindings: (count) =>
      `**${count} ${count === 1 ? 'hallazgo más omitido' : 'hallazgos más omitidos'} de este resumen por el límite de tamaño.**`,
    lifecycle: {
      resolved: 'resuelto',
      active: 'sigue vigente',
      carried: 'arrastrado, no revalidado',
      uncertain: 'requiere atención',
      suppressed: 'omitido',
    },
  },
  pt: {
    noFindingsHeading: '## Nenhum achado',
    limitedNoFindingsHeading: '## Nenhum achado nos arquivos revisados',
    dismissedNote: (count) =>
      `${count} achados dispensados pelo comando \`/rr skip\` de um mantenedor ou administrador.`,
    findingsHeading: (counts) =>
      `## ${counts.total} ${counts.total === 1 ? 'achado' : 'achados'} (${formatSeverityCounts(counts)})`,
    incompleteCauseHeading: '**Por que a revisão não está completa:**',
    incompleteCauses: {
      attempt_budget_exhausted:
        'O provedor de revisão esgotou suas tentativas sem retornar evidência.',
      not_runnable:
        'Não foi possível executar uma unidade de revisão obrigatória.',
      provider_lane_busy:
        'O provedor de revisão ficou indisponível (ocupado ou no limite de capacidade) durante toda a execução.',
      investigation_deferred:
        'Uma investigação de contexto foi adiada, então a revisão não conseguiu cobrir tudo.',
      restored_terminal:
        'Esta execução retomou uma tentativa anterior que já havia terminado sem evidência.',
      deadline_reached: 'A revisão esgotou seu orçamento de tempo de execução.',
      admission_limited:
        'A política de admissão limitou esta revisão antes que ela pudesse ser concluída.',
    },
    providerFailures: (failed, planned) =>
      `${failed} de ${planned} provedores de revisão falharam.`,
    location: 'Local',
    fix: 'Correção',
    incompleteHeading: (count) =>
      `## Revisão incompleta — ${count} ${count === 1 ? 'achado preliminar' : 'achados preliminares'}`,
    incompleteNote:
      'Comentários inline e mudanças de ciclo de vida não foram publicados porque a cobertura não foi concluída.',
    coverageHeading: '### Cobertura não concluída',
    manifestHeading: '### Cobertura de arquivos',
    moreFiles: (count) =>
      `**Mais ${count} ${count === 1 ? 'arquivo não exibido.' : 'arquivos não exibidos.'}**`,
    moreFindings: (count) =>
      `**Mais ${count} ${count === 1 ? 'achado omitido' : 'achados omitidos'} deste resumo por limite de tamanho.**`,
    lifecycle: {
      resolved: 'resolvido',
      active: 'ainda válido',
      carried: 'carregado, não revalidado',
      uncertain: 'precisa de atenção',
      suppressed: 'suprimido',
    },
  },
  fr: {
    noFindingsHeading: '## Aucune anomalie',
    limitedNoFindingsHeading: '## Aucune anomalie dans les fichiers examinés',
    dismissedNote: (count) =>
      `${count} anomalies écartées par la commande \`/rr skip\` d’un responsable ou administrateur.`,
    findingsHeading: (counts) =>
      `## ${counts.total} ${counts.total === 1 ? 'anomalie' : 'anomalies'} (${formatSeverityCounts(counts)})`,
    incompleteCauseHeading: '**Pourquoi la revue est incomplète :**',
    incompleteCauses: {
      attempt_budget_exhausted:
        'Le fournisseur de revue a épuisé ses tentatives sans renvoyer de preuve.',
      not_runnable:
        "Une unité de revue obligatoire n'a pas pu être exécutée du tout.",
      provider_lane_busy:
        "Le fournisseur de revue est resté indisponible (occupé ou à saturation) pendant toute l'exécution.",
      investigation_deferred:
        "Une investigation de contexte a été reportée, la revue n'a donc pas pu tout couvrir.",
      restored_terminal:
        'Cette exécution a repris une tentative précédente déjà terminée sans preuve.',
      deadline_reached: "La revue a épuisé son budget de temps d'exécution.",
      admission_limited:
        "La politique d'admission a limité cette revue avant qu'elle ne puisse se terminer.",
    },
    providerFailures: (failed, planned) =>
      `${failed} fournisseur(s) de revue sur ${planned} ont échoué.`,
    location: 'Emplacement',
    fix: 'Correctif',
    incompleteHeading: (count) =>
      `## Revue incomplète — ${count} ${count === 1 ? 'anomalie préliminaire' : 'anomalies préliminaires'}`,
    incompleteNote:
      'Les commentaires inline et les changements de cycle de vie n’ont pas été publiés car la couverture est incomplète.',
    coverageHeading: '### Couverture incomplète',
    manifestHeading: '### Couverture des fichiers',
    moreFiles: (count) =>
      `**${count} ${count === 1 ? 'fichier supplémentaire non affiché.' : 'fichiers supplémentaires non affichés.'}**`,
    moreFindings: (count) =>
      `**${count} ${count === 1 ? 'anomalie supplémentaire omise' : 'anomalies supplémentaires omises'} de ce résumé à cause de la limite de taille.**`,
    lifecycle: {
      resolved: 'résolu',
      active: 'toujours valide',
      carried: 'reporté, non revalidé',
      uncertain: 'nécessite une attention',
      suppressed: 'masqué',
    },
  },
  de: {
    noFindingsHeading: '## Keine Befunde',
    limitedNoFindingsHeading: '## Keine Befunde in den geprüften Dateien',
    dismissedNote: (count) =>
      `${count} Befunde durch den Befehl \`/rr skip\` eines Maintainers oder Administrators verworfen.`,
    findingsHeading: (counts) =>
      `## ${counts.total} ${counts.total === 1 ? 'Befund' : 'Befunde'} (${formatSeverityCounts(counts)})`,
    incompleteCauseHeading: '**Warum die Prüfung unvollständig ist:**',
    incompleteCauses: {
      attempt_budget_exhausted:
        'Der Prüfanbieter hat seine Versuche aufgebraucht, ohne Ergebnisse zurückzugeben.',
      not_runnable:
        'Eine erforderliche Prüfeinheit konnte überhaupt nicht ausgeführt werden.',
      provider_lane_busy:
        'Der Prüfanbieter war während des gesamten Laufs nicht verfügbar (ausgelastet oder an der Kapazitätsgrenze).',
      investigation_deferred:
        'Eine Kontextuntersuchung wurde verschoben, daher konnte die Prüfung nicht alles abdecken.',
      restored_terminal:
        'Dieser Lauf hat einen früheren Versuch fortgesetzt, der bereits ohne Ergebnisse endete.',
      deadline_reached:
        'Der Prüfung ist ihr Ausführungszeitbudget ausgegangen.',
      admission_limited:
        'Die Zulassungsrichtlinie hat diese Prüfung begrenzt, bevor sie abschließen konnte.',
    },
    providerFailures: (failed, planned) =>
      `${failed} von ${planned} Review-Providern sind fehlgeschlagen.`,
    location: 'Stelle',
    fix: 'Fix',
    incompleteHeading: (count) =>
      `## Review unvollständig — ${count} vorläufige ${count === 1 ? 'Befund' : 'Befunde'}`,
    incompleteNote:
      'Inline-Kommentare und Lifecycle-Änderungen wurden nicht veröffentlicht, weil die Abdeckung unvollständig ist.',
    coverageHeading: '### Abdeckung unvollständig',
    manifestHeading: '### Dateiabdeckung',
    moreFiles: (count) =>
      count === 1
        ? '**1 weitere Datei wird nicht angezeigt.**'
        : `**${count} weitere Dateien werden nicht angezeigt.**`,
    moreFindings: (count) =>
      `**${count} weitere ${count === 1 ? 'Befund' : 'Befunde'} fehlen in dieser Zusammenfassung wegen des Größenlimits.**`,
    lifecycle: {
      active: 'weiterhin gültig',
      resolved: 'erledigt',
      carried: 'übernommen, nicht erneut geprüft',
      uncertain: 'braucht Aufmerksamkeit',
      suppressed: 'unterdrückt',
    },
  },
  it: {
    noFindingsHeading: '## Nessun rilievo',
    limitedNoFindingsHeading: '## Nessun rilievo nei file esaminati',
    dismissedNote: (count) =>
      `${count} riscontri esclusi dal comando \`/rr skip\` di un manutentore o amministratore.`,
    findingsHeading: (counts) =>
      `## ${counts.total} ${counts.total === 1 ? 'rilievo' : 'rilievi'} (${formatSeverityCounts(counts)})`,
    incompleteCauseHeading: '**Perché la revisione è incompleta:**',
    incompleteCauses: {
      attempt_budget_exhausted:
        'Il fornitore della revisione ha esaurito i tentativi senza restituire evidenze.',
      not_runnable:
        "Non è stato possibile eseguire affatto un'unità di revisione obbligatoria.",
      provider_lane_busy:
        "Il fornitore della revisione è rimasto non disponibile (occupato o al limite della capacità) per tutta l'esecuzione.",
      investigation_deferred:
        "Un'indagine sul contesto è stata rinviata, quindi la revisione non ha potuto coprire tutto.",
      restored_terminal:
        'Questa esecuzione ha ripreso un tentativo precedente già concluso senza evidenze.',
      deadline_reached:
        'La revisione ha esaurito il suo budget di tempo di esecuzione.',
      admission_limited:
        'La politica di ammissione ha limitato questa revisione prima che potesse concludersi.',
    },
    providerFailures: (failed, planned) =>
      `${failed} di ${planned} provider di review non sono riusciti.`,
    location: 'Posizione',
    fix: 'Correzione',
    incompleteHeading: (count) =>
      `## Review incompleta — ${count} ${count === 1 ? 'rilievo preliminare' : 'rilievi preliminari'}`,
    incompleteNote:
      'I commenti inline e le modifiche di lifecycle non sono stati pubblicati perché la copertura non è completa.',
    coverageHeading: '### Copertura non completata',
    manifestHeading: '### Copertura dei file',
    moreFiles: (count) =>
      `**${count} ${count === 1 ? 'file aggiuntivo non mostrato.' : 'file aggiuntivi non mostrati.'}**`,
    moreFindings: (count) =>
      `**Altri ${count} ${count === 1 ? 'rilievo omesso' : 'rilievi omessi'} da questo riassunto per il limite di dimensione.**`,
    lifecycle: {
      resolved: 'risolto',
      active: 'ancora valido',
      carried: 'riportato, non rivalidato',
      uncertain: 'richiede attenzione',
      suppressed: 'soppresso',
    },
  },
  zh: {
    noFindingsHeading: '## 无问题',
    limitedNoFindingsHeading: '## 已审查文件中无问题',
    dismissedNote: (count) =>
      `${count} 个问题由维护者或管理员通过 \`/rr skip\` 命令忽略。`,
    findingsHeading: (counts) =>
      `## ${counts.total} 个问题（${formatSeverityCounts(counts)}）`,
    incompleteCauseHeading: '**为什么本次审查未完成：**',
    incompleteCauses: {
      attempt_budget_exhausted: '审查提供方用尽了重试次数仍未返回证据。',
      not_runnable: '一个必需的审查单元根本无法运行。',
      provider_lane_busy:
        '整个运行期间审查提供方一直不可用（繁忙或达到容量上限）。',
      investigation_deferred: '上下文调查被推迟，因此审查无法覆盖全部内容。',
      restored_terminal: '本次运行接续了之前一次已经无证据结束的尝试。',
      deadline_reached: '审查的执行时间预算已用尽。',
      admission_limited: '准入策略在审查完成之前对其进行了限制。',
    },
    providerFailures: (failed, planned) =>
      `${planned} 个审查提供方中有 ${failed} 个失败。`,
    location: '位置',
    fix: '修复',
    incompleteHeading: (count) => `## 审查未完成 — 保留 ${count} 条初步问题`,
    incompleteNote: '因覆盖未完成，未发布行内评论和生命周期变更。',
    coverageHeading: '### 覆盖未完成',
    manifestHeading: '### 文件覆盖',
    moreFiles: (count) => `**另有 ${count} 个文件未显示。**`,
    moreFindings: (count) => `**受篇幅限制，本摘要还省略了 ${count} 条问题。**`,
    lifecycle: {
      resolved: '已解决',
      active: '仍然有效',
      carried: '沿用，未复验',
      uncertain: '需要关注',
      suppressed: '已抑制',
    },
  },
  ja: {
    noFindingsHeading: '## 指摘なし',
    limitedNoFindingsHeading: '## レビュー対象ファイルに指摘なし',
    dismissedNote: (count) =>
      `${count} 件の指摘がメンテナーまたは管理者の \`/rr skip\` コマンドにより除外されました。`,
    findingsHeading: (counts) =>
      `## 指摘 ${counts.total} 件（${formatSeverityCounts(counts)}）`,
    incompleteCauseHeading: '**レビューが完了しなかった理由:**',
    incompleteCauses: {
      attempt_budget_exhausted:
        'レビュー提供者が証拠を返さずに再試行を使い切りました。',
      not_runnable: '必須のレビュー単元をまったく実行できませんでした。',
      provider_lane_busy:
        '実行全体を通じてレビュー提供者が利用不能でした（混雑または容量上限）。',
      investigation_deferred:
        'コンテキスト調査が先送りされたため、レビューが全体をカバーできませんでした。',
      restored_terminal:
        'この実行は、証拠なしで終了した以前の試行を再開したものです。',
      deadline_reached: 'レビューの実行時間予算が尽きました。',
      admission_limited:
        '採用ポリシーにより、レビューが完了する前に制限されました。',
    },
    providerFailures: (failed, planned) =>
      `レビュープロバイダー ${planned} 件中 ${failed} 件が失敗しました。`,
    location: '場所',
    fix: '修正',
    incompleteHeading: (count) => `## レビュー未完了 — 暫定の指摘 ${count} 件`,
    incompleteNote:
      'カバレッジが完了していないため、インラインコメントとライフサイクル変更は投稿していません。',
    coverageHeading: '### カバレッジ未完了',
    manifestHeading: '### ファイルカバレッジ',
    moreFiles: (count) =>
      `**さらに ${count} 件のファイルは表示されていません。**`,
    moreFindings: (count) =>
      `**サイズ制限のため、この要約から指摘がさらに ${count} 件省略されています。**`,
    lifecycle: {
      resolved: '解決済み',
      active: '引き続き有効',
      carried: '持ち越し、再検証なし',
      uncertain: '要確認',
      suppressed: '抑制済み',
    },
  },
  ko: {
    noFindingsHeading: '## 이슈 없음',
    limitedNoFindingsHeading: '## 검토한 파일에서 이슈 없음',
    dismissedNote: (count) =>
      `유지관리자 또는 관리자의 \`/rr skip\` 명령으로 이슈 ${count}개를 제외했습니다.`,
    findingsHeading: (counts) =>
      `## 이슈 ${counts.total}개 (${formatSeverityCounts(counts)})`,
    incompleteCauseHeading: '**리뷰가 완료되지 않은 이유:**',
    incompleteCauses: {
      attempt_budget_exhausted:
        '리뷰 제공자가 증거를 반환하지 못한 채 재시도를 모두 소진했습니다.',
      not_runnable: '필수 리뷰 단위를 전혀 실행할 수 없었습니다.',
      provider_lane_busy:
        '실행 내내 리뷰 제공자를 사용할 수 없었습니다(혼잡 또는 용량 한계).',
      investigation_deferred:
        '컨텍스트 조사가 연기되어 리뷰가 전체를 다루지 못했습니다.',
      restored_terminal:
        '이 실행은 증거 없이 끝난 이전 시도를 재개한 것입니다.',
      deadline_reached: '리뷰의 실행 시간 예산이 소진되었습니다.',
      admission_limited: '채택 정책이 리뷰가 끝나기 전에 제한했습니다.',
    },
    providerFailures: (failed, planned) =>
      `리뷰 제공자 ${planned}개 중 ${failed}개가 실패했습니다.`,
    location: '위치',
    fix: '수정',
    incompleteHeading: (count) => `## 리뷰 미완료 — 예비 이슈 ${count}개`,
    incompleteNote:
      '커버리지가 끝나지 않아 인라인 댓글과 라이프사이클 변경을 게시하지 않았습니다.',
    coverageHeading: '### 커버리지 미완료',
    manifestHeading: '### 파일 커버리지',
    moreFiles: (count) => `**파일 ${count}개가 표시되지 않았습니다.**`,
    moreFindings: (count) =>
      `**크기 제한 때문에 이 요약에서 이슈 ${count}개가 더 생략되었습니다.**`,
    lifecycle: {
      resolved: '해결됨',
      active: '여전히 유효',
      carried: '이월됨, 재검증 안 함',
      uncertain: '확인 필요',
      suppressed: '숨김',
    },
  },
};

type SectionCopy = Record<
  | 'summary'
  | 'findings'
  | 'previous'
  | 'dismissed'
  | 'scope'
  | 'performance'
  | 'metric'
  | 'value'
  | 'files'
  | 'unreviewed'
  | 'mode'
  | 'providers'
  | 'duration'
  | 'tokens'
  | 'cost'
  | 'cache'
  | 'attention'
  | 'analysis'
  | 'impact',
  string
>;
const sectionWords: Record<ReviewerSummaryLocale, readonly string[]> = {
  en: [
    'Summary',
    'Findings',
    'Previous Review Threads',
    'Dismissed findings',
    'Review Scope',
    'Performance Metrics',
    'Metric',
    'Value',
    'Files reviewed',
    'Not reviewed',
    'Review mode',
    'Providers',
    'Duration',
    'Tokens',
    'Cost',
    'Cache',
    'Lifecycle attention required',
    'AI-Generated Code Analysis',
    'Impact Analysis Graph',
  ],
  ru: [
    'Итоги',
    'Замечания',
    'Предыдущие обсуждения',
    'Отклонённые замечания',
    'Область ревью',
    'Метрики выполнения',
    'Метрика',
    'Значение',
    'Проверено файлов',
    'Не проверено',
    'Режим ревью',
    'Провайдеры',
    'Длительность',
    'Токены',
    'Стоимость',
    'Кэш',
    'Нужно внимание к предыдущим обсуждениям',
    'Анализ ИИ-кода',
    'Граф влияния',
  ],
  uk: [
    'Підсумок',
    'Зауваження',
    'Попередні обговорення',
    'Відхилені зауваження',
    'Область рев’ю',
    'Метрики виконання',
    'Метрика',
    'Значення',
    'Перевірено файлів',
    'Не перевірено',
    'Режим рев’ю',
    'Провайдери',
    'Тривалість',
    'Токени',
    'Вартість',
    'Кеш',
    'Потрібна увага до попередніх обговорень',
    'Аналіз ШІ-коду',
    'Граф впливу',
  ],
  es: [
    'Resumen',
    'Hallazgos',
    'Hilos anteriores',
    'Hallazgos descartados',
    'Alcance',
    'Métricas',
    'Métrica',
    'Valor',
    'Archivos revisados',
    'Sin revisar',
    'Modo',
    'Proveedores',
    'Duración',
    'Tokens',
    'Coste',
    'Caché',
    'Revisar hilos anteriores',
    'Análisis de código IA',
    'Grafo de impacto',
  ],
  pt: [
    'Resumo',
    'Achados',
    'Discussões anteriores',
    'Achados dispensados',
    'Escopo',
    'Métricas',
    'Métrica',
    'Valor',
    'Arquivos revisados',
    'Não revisados',
    'Modo',
    'Provedores',
    'Duração',
    'Tokens',
    'Custo',
    'Cache',
    'Atenção às discussões anteriores',
    'Análise de código IA',
    'Grafo de impacto',
  ],
  fr: [
    'Résumé',
    'Anomalies',
    'Discussions précédentes',
    'Anomalies écartées',
    'Périmètre',
    'Métriques',
    'Métrique',
    'Valeur',
    'Fichiers revus',
    'Non revus',
    'Mode',
    'Fournisseurs',
    'Durée',
    'Jetons',
    'Coût',
    'Cache',
    'Discussions à vérifier',
    'Analyse de code IA',
    'Graphe d’impact',
  ],
  de: [
    'Zusammenfassung',
    'Befunde',
    'Frühere Diskussionen',
    'Verworfene Befunde',
    'Prüfumfang',
    'Leistungsmetriken',
    'Metrik',
    'Wert',
    'Geprüfte Dateien',
    'Nicht geprüft',
    'Modus',
    'Anbieter',
    'Dauer',
    'Token',
    'Kosten',
    'Cache',
    'Frühere Diskussionen prüfen',
    'KI-Codeanalyse',
    'Auswirkungsgraph',
  ],
  it: [
    'Riepilogo',
    'Riscontri',
    'Discussioni precedenti',
    'Riscontri esclusi',
    'Ambito',
    'Metriche',
    'Metrica',
    'Valore',
    'File esaminati',
    'Non esaminati',
    'Modalità',
    'Fornitori',
    'Durata',
    'Token',
    'Costo',
    'Cache',
    'Discussioni da verificare',
    'Analisi codice IA',
    'Grafo di impatto',
  ],
  zh: [
    '总结',
    '问题',
    '历史讨论',
    '已忽略问题',
    '审查范围',
    '性能指标',
    '指标',
    '值',
    '已审查文件',
    '未审查',
    '模式',
    '提供方',
    '耗时',
    '令牌',
    '费用',
    '缓存',
    '历史讨论需要关注',
    'AI代码分析',
    '影响图',
  ],
  ja: [
    '要約',
    '指摘',
    '以前の議論',
    '除外した指摘',
    'レビュー範囲',
    '実行指標',
    '指標',
    '値',
    '確認済みファイル',
    '未確認',
    'モード',
    'プロバイダー',
    '所要時間',
    'トークン',
    '費用',
    'キャッシュ',
    '以前の議論を確認してください',
    'AIコード分析',
    '影響図',
  ],
  ko: [
    '요약',
    '이슈',
    '이전 논의',
    '제외된 이슈',
    '리뷰 범위',
    '실행 지표',
    '지표',
    '값',
    '검토한 파일',
    '미검토',
    '모드',
    '제공자',
    '소요 시간',
    '토큰',
    '비용',
    '캐시',
    '이전 논의 확인 필요',
    'AI 코드 분석',
    '영향 그래프',
  ],
};
const sectionKeys: readonly (keyof SectionCopy)[] = [
  'summary',
  'findings',
  'previous',
  'dismissed',
  'scope',
  'performance',
  'metric',
  'value',
  'files',
  'unreviewed',
  'mode',
  'providers',
  'duration',
  'tokens',
  'cost',
  'cache',
  'attention',
  'analysis',
  'impact',
];
const sectionCopy = Object.fromEntries(
  Object.entries(sectionWords).map(([locale, words]) => [
    locale,
    Object.fromEntries(sectionKeys.map((key, index) => [key, words[index]])),
  ])
) as Record<ReviewerSummaryLocale, SectionCopy>;

type ScopeCopy = Record<
  | 'fullDiff'
  | 'compacted'
  | 'metadataOnly'
  | 'skipped'
  | 'excludedByPolicy'
  | 'context'
  | 'release'
  | 'billing'
  | 'unknown'
  | 'providerPerformance'
  | 'required'
  | 'tests',
  string
>;
const scopeCopy: Record<ReviewerSummaryLocale, ScopeCopy> = {
  en: {
    fullDiff: 'Full diff in prompt',
    compacted: 'Compacted in prompt',
    metadataOnly: 'Metadata-only or trimmed',
    skipped: 'Skipped before LLM review',
    excludedByPolicy: 'Excluded by review policy',
    context: 'Agentic context',
    release: 'Release Notes',
    billing: 'Billing',
    unknown: 'Not reported',
    providerPerformance: 'Provider Performance',
    required: 'required',
    tests: 'Suggested tests',
  },
  ru: {
    fullDiff: 'Полный diff',
    compacted: 'Сокращённый diff',
    metadataOnly: 'Только метаданные',
    skipped: 'Пропущено до LLM',
    excludedByPolicy: 'Исключено политикой ревью',
    context: 'Агентный контекст',
    release: 'Примечания к изменениям',
    billing: 'Оплата',
    unknown: 'Не указана',
    providerPerformance: 'Выполнение провайдеров',
    required: 'обязательный',
    tests: 'Рекомендуемые тесты',
  },
  uk: {
    fullDiff: 'Повний diff',
    compacted: 'Скорочений diff',
    metadataOnly: 'Лише метадані',
    skipped: 'Пропущено до LLM',
    excludedByPolicy: 'Виключено політикою рев’ю',
    context: 'Агентний контекст',
    release: 'Примітки до змін',
    billing: 'Оплата',
    unknown: 'Не вказано',
    providerPerformance: 'Виконання провайдерів',
    required: 'обов’язковий',
    tests: 'Рекомендовані тести',
  },
  es: {
    fullDiff: 'Diff completo',
    compacted: 'Diff reducido',
    metadataOnly: 'Solo metadatos',
    skipped: 'Omitidos antes del LLM',
    excludedByPolicy: 'Excluidos por la política de revisión',
    context: 'Contexto agente',
    release: 'Notas de cambios',
    billing: 'Facturación',
    unknown: 'Sin datos',
    providerPerformance: 'Rendimiento de proveedores',
    required: 'obligatorio',
    tests: 'Pruebas sugeridas',
  },
  pt: {
    fullDiff: 'Diff completo',
    compacted: 'Diff reduzido',
    metadataOnly: 'Só metadados',
    skipped: 'Ignorados antes do LLM',
    excludedByPolicy: 'Excluídos pela política de revisão',
    context: 'Contexto agente',
    release: 'Notas de alterações',
    billing: 'Cobrança',
    unknown: 'Não informado',
    providerPerformance: 'Desempenho dos provedores',
    required: 'obrigatório',
    tests: 'Testes sugeridos',
  },
  fr: {
    fullDiff: 'Diff complet',
    compacted: 'Diff réduit',
    metadataOnly: 'Métadonnées seules',
    skipped: 'Ignorés avant LLM',
    excludedByPolicy: 'Exclus par la politique de revue',
    context: 'Contexte agent',
    release: 'Notes de changements',
    billing: 'Facturation',
    unknown: 'Non renseignée',
    providerPerformance: 'Performance des fournisseurs',
    required: 'requis',
    tests: 'Tests proposés',
  },
  de: {
    fullDiff: 'Vollständiger Diff',
    compacted: 'Gekürzter Diff',
    metadataOnly: 'Nur Metadaten',
    skipped: 'Vor LLM übersprungen',
    excludedByPolicy: 'Durch Review-Richtlinie ausgeschlossen',
    context: 'Agentenkontext',
    release: 'Änderungsnotizen',
    billing: 'Abrechnung',
    unknown: 'Nicht angegeben',
    providerPerformance: 'Anbieterleistung',
    required: 'erforderlich',
    tests: 'Testvorschläge',
  },
  it: {
    fullDiff: 'Diff completo',
    compacted: 'Diff ridotto',
    metadataOnly: 'Solo metadati',
    skipped: 'Esclusi prima del LLM',
    excludedByPolicy: 'Esclusi dalla politica di revisione',
    context: 'Contesto agente',
    release: 'Note sulle modifiche',
    billing: 'Fatturazione',
    unknown: 'Non riportata',
    providerPerformance: 'Prestazioni fornitori',
    required: 'obbligatorio',
    tests: 'Test suggeriti',
  },
  zh: {
    fullDiff: '完整差异',
    compacted: '压缩差异',
    metadataOnly: '仅元数据',
    skipped: 'LLM前跳过',
    excludedByPolicy: '按审查策略排除',
    context: '代理上下文',
    release: '变更说明',
    billing: '计费',
    unknown: '未报告',
    providerPerformance: '提供方性能',
    required: '必需',
    tests: '建议测试',
  },
  ja: {
    fullDiff: '完全な差分',
    compacted: '圧縮した差分',
    metadataOnly: 'メタデータのみ',
    skipped: 'LLM前に除外',
    excludedByPolicy: 'レビューポリシーにより除外',
    context: 'エージェント文脈',
    release: '変更内容',
    billing: '課金',
    unknown: '未報告',
    providerPerformance: 'プロバイダー実績',
    required: '必須',
    tests: '推奨テスト',
  },
  ko: {
    fullDiff: '전체 차이',
    compacted: '축약한 차이',
    metadataOnly: '메타데이터만',
    skipped: 'LLM 이전 제외',
    excludedByPolicy: '검토 정책에 따라 제외',
    context: '에이전트 컨텍스트',
    release: '변경 사항',
    billing: '과금',
    unknown: '미보고',
    providerPerformance: '제공자 실행',
    required: '필수',
    tests: '권장 테스트',
  },
};

// Incomplete summaries surface coverage gaps before fully reviewed files.
function compareCoverageManifestFiles(
  left: { readonly path: string; readonly status: string },
  right: { readonly path: string; readonly status: string }
): number {
  const leftRank = coverageManifestFileStatusRank(left.status);
  const rightRank = coverageManifestFileStatusRank(right.status);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function isRawLimitationToken(value: string): boolean {
  return /^[a-z_]+:/.test(value);
}

function escapeMarkdownText(value: string): string {
  return neutralizeDetailsMarkup(escapeHtml(value)).replace(
    /[\\`*_{}[\]()|]/g,
    '\\$&'
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Coverage paths are attacker-controlled PR filenames: a backtick, @, or
// newline must never break out of the manifest line into raw markdown/HTML.
function escapeCoverageManifestPath(value: string): string {
  const sanitized = Array.from(value, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? ' ' : char;
  }).join('');
  const escaped = escapeHtml(sanitized)
    .replaceAll('`', '&#96;')
    .replaceAll('@', '&#64;')
    .replaceAll('[', '&#91;')
    .replaceAll(']', '&#93;');
  return `<code>${escaped}</code>`;
}

function limitUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffix = '\n\n[truncated]';
  const retained: string[] = [];
  let block: string[] = [];
  let depth = 0;
  let fence: MarkdownFence | undefined;
  for (const original of value.split('\n')) {
    const next = advanceMarkdownFence(original, fence);
    const line = next.normalized ?? original;
    if (next.closing) block.push(next.closing);
    fence = next.fence;
    if (!fence) {
      depth += (line.match(/<details\b[^>]*>/gi) ?? []).length;
      depth -= (line.match(/<\/details>/gi) ?? []).length;
    }
    block.push(line);
    if (
      !fence &&
      depth === 0 &&
      (!line.trim() || line.includes('</details>'))
    ) {
      const candidate = [...retained, ...block].join('\n');
      if (utf8Bytes(candidate + suffix) > maxBytes) break;
      retained.push(...block);
      block = [];
    }
  }
  if (
    !fence &&
    depth === 0 &&
    utf8Bytes([...retained, ...block].join('\n') + suffix) <= maxBytes
  )
    retained.push(...block);
  return retained.join('\n').trimEnd() + suffix;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

type CompactCopy = {
  readonly details: string;
  readonly findingDetails: string;
  readonly omitted: string;
  readonly evidence: string;
  readonly model: string;
  readonly models: string;
  readonly agreement: string;
};
const compactWords: Record<ReviewerSummaryLocale, readonly string[]> = {
  en: [
    'Review details',
    'Some content was omitted to fit the comment limit. Full findings remain in the review JSON artifact.',
    'Evidence',
    'Model',
    'Models',
    'agreement',
    'Details',
  ],
  ru: [
    'Подробности ревью',
    'Часть содержимого пропущена из-за лимита комментария. Полные замечания сохранены в JSON-артефакте ревью.',
    'Доказательства',
    'Модель',
    'Модели',
    'согласие',
    'Подробности',
  ],
  uk: [
    'Подробиці рев’ю',
    'Частину вмісту пропущено через ліміт коментаря. Повні зауваження збережено в JSON-артефакті рев’ю.',
    'Докази',
    'Модель',
    'Моделі',
    'згода',
    'Подробиці',
  ],
  es: [
    'Detalles de revisión',
    'Se omitió contenido por el límite del comentario. Los hallazgos completos se conservan en el artefacto JSON.',
    'Evidencia',
    'Modelo',
    'Modelos',
    'acuerdo',
    'Detalles',
  ],
  pt: [
    'Detalhes da revisão',
    'Parte do conteúdo foi omitida pelo limite do comentário. Os achados completos estão no artefato JSON.',
    'Evidência',
    'Modelo',
    'Modelos',
    'concordância',
    'Detalhes',
  ],
  fr: [
    'Détails de la revue',
    'Du contenu a été omis à cause de la limite du commentaire. Les anomalies complètes restent dans l’artefact JSON.',
    'Preuves',
    'Modèle',
    'Modèles',
    'accord',
    'Détails',
  ],
  de: [
    'Review-Details',
    'Inhalte wurden wegen des Kommentarlimits ausgelassen. Vollständige Befunde bleiben im JSON-Artefakt.',
    'Nachweise',
    'Modell',
    'Modelle',
    'Übereinstimmung',
    'Details',
  ],
  it: [
    'Dettagli della review',
    'Parte del contenuto è omessa per il limite del commento. I riscontri completi restano nell’artefatto JSON.',
    'Evidenze',
    'Modello',
    'Modelli',
    'accordo',
    'Dettagli',
  ],
  zh: [
    '审查详情',
    '受评论长度限制，部分内容已省略。完整问题保留在审查 JSON 产物中。',
    '证据',
    '模型',
    '模型',
    '一致',
    '详情',
  ],
  ja: [
    'レビューの詳細',
    'コメントの上限により一部を省略しました。完全な指摘はレビューの JSON 成果物に残っています。',
    '根拠',
    'モデル',
    'モデル',
    '一致',
    '詳細',
  ],
  ko: [
    '리뷰 상세',
    '댓글 크기 제한으로 일부 내용을 생략했습니다. 전체 이슈는 리뷰 JSON 결과물에 보존됩니다.',
    '근거',
    '모델',
    '모델',
    '일치',
    '상세',
  ],
};
const compactCopy = Object.fromEntries(
  Object.entries(compactWords).map(([locale, words]) => [
    locale,
    Object.fromEntries(
      [
        'details',
        'omitted',
        'evidence',
        'model',
        'models',
        'agreement',
        'findingDetails',
      ].map((key, i) => [key, words[i]])
    ),
  ])
) as Record<ReviewerSummaryLocale, CompactCopy>;

function plainExcerpt(
  value: string,
  maxChars: number,
  locale: ReviewerSummaryLocale
): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  const candidate = chars.slice(0, maxChars - 1).join('');
  const lastSpace = candidate.search(/\s+\S*$/u);
  if (lastSpace > 0) return `${candidate.slice(0, lastSpace).trimEnd()}…`;
  // CJK prose often has no spaces. ICU supplies word boundaries without
  // splitting long identifiers; URL tokens must remain whole as well.
  const urls = Array.from(
    value.matchAll(/\b(?:[a-z][a-z\d+.-]*:|www\.)\S+/giu),
    (match) => ({
      start: match.index!,
      end: match.index! + match[0].length,
    })
  );
  let boundary = 0;
  for (const segment of new Intl.Segmenter(locale, {
    granularity: 'word',
  }).segment(value)) {
    const end = segment.index + segment.segment.length;
    if (end > candidate.length) break;
    if (
      segment.isWordLike &&
      !urls.some((url) => url.start < end && end < url.end)
    )
      boundary = end;
  }
  return boundary > 0 ? `${value.slice(0, boundary).trimEnd()}…` : '';
}

function compactFindingPresentation(
  finding: Pick<ReviewerSummaryFinding, 'title' | 'message'>,
  locale: ReviewerSummaryLocale
): { readonly title: string; readonly excerpt: string } {
  const paragraph = plainInlineCode(findingParagraph(finding.message));
  const originalTitle = plainInlineCode(singleLineText(finding.title).trim());
  const firstSentence = (value: string) => {
    const sentences = new Intl.Segmenter(locale, {
      granularity: 'sentence',
    }).segment(value);
    return sentences[Symbol.iterator]().next().value?.segment.trim() ?? value;
  };
  // Some adapters derive a title from the message, stripping Markdown and
  // truncating at their wire limit. Compare content without punctuation so
  // display can recover operators from the intact body without changing IDs.
  const comparable = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, '');
  const titleKey = comparable(originalTitle);
  const paragraphKey = comparable(paragraph);
  const firstLineKey = comparable(
    finding.message.split(/\r\n|\r|\n/u).find((line) => line.trim()) ?? ''
  );
  const derived =
    titleKey.length > 0 &&
    (titleKey === paragraphKey ||
      titleKey === comparable(firstSentence(paragraph)) ||
      (titleKey === firstLineKey && paragraphKey.startsWith(titleKey)) ||
      (Array.from(originalTitle).length > 120 &&
        paragraphKey.startsWith(titleKey)));
  const title =
    plainExcerpt(
      firstSentence(derived ? paragraph : originalTitle),
      120,
      locale
    ) || '…';
  // A clipped title can end halfway through an expression. Continue after its
  // complete sentence, rather than presenting the leftover fragment as prose.
  // The full sentence remains available in the finding details.
  const consumed = title.endsWith('…') ? firstSentence(paragraph) : title;
  const remaining =
    derived && paragraph.startsWith(consumed)
      ? paragraph.slice(consumed.length).trimStart()
      : paragraph;
  return { title, excerpt: plainExcerpt(remaining, 320, locale) };
}

/** Plain preview text: remove matched code delimiters, retaining operators. */
function plainInlineCode(value: string): string {
  const ticks = Array.from(value.matchAll(/`+/g));
  let result = '';
  let cursor = 0;
  for (let index = 0; index < ticks.length; index++) {
    const opening = ticks[index]!;
    let slashes = 0;
    for (let at = opening.index! - 1; at >= 0 && value[at] === '\\'; at--)
      slashes++;
    if (slashes % 2) continue;
    const closing = ticks.findIndex(
      (tick, candidate) =>
        candidate > index && tick[0].length === opening[0].length
    );
    if (closing < 0) continue;
    result +=
      value.slice(cursor, opening.index!) +
      value.slice(opening.index! + opening[0].length, ticks[closing]!.index!);
    cursor = ticks[closing]!.index! + ticks[closing]![0].length;
    index = closing;
  }
  return result + value.slice(cursor);
}

function findingParagraph(message: string): string {
  const first =
    message
      .replace(/^(?:[ \t]*\r?\n)+/, '')
      .trimEnd()
      .split(/\r?\n\s*\r?\n/)[0] ?? '';
  if (
    /^(?: {4}|\t|\s*(?:`{3}|~{3}|<|\||#{1,6}\s|>|[-*+]\s|\d+[.)]\s))/.test(
      first
    )
  )
    return '';
  const lines = first.split(/\r?\n/);
  const paragraph: string[] = [];
  for (const line of lines) {
    // Setext headings and table headers are not ordinary paragraphs. Only
    // inspect paragraph lines, never delimiters inside the following block.
    if (/^ {0,3}(?:=+[ \t]*$|-+[ \t]*$|\|?\s*:?-{3})/.test(line)) return '';
    // Block constructs can interrupt a paragraph without a preceding blank
    // line. Keep soft-wrapped prose together, but never expose the next block.
    if (markdownInterruptsParagraph(line)) break;
    paragraph.push(line);
  }
  return paragraph.join(' ').replace(/\s+/g, ' ').trim();
}

function markdownInterruptsParagraph(line: string): boolean {
  return (
    !!readMarkdownFenceOpening(line) ||
    /^ {0,3}(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s|=+[ \t]*$|\|?\s*:?-{3}|(?:[-*_][ \t]*){3,}$)/.test(
      line
    ) ||
    htmlInterruptsParagraph(line)
  );
}

function htmlInterruptsParagraph(line: string): boolean {
  // CommonMark HTML block types 1-6 interrupt paragraphs. Inline/custom tags,
  // autolinks and comparisons starting with < remain ordinary continuations.
  return /^ {0,3}<(?:!--|\?|!\[CDATA\[|![A-Z]|\/?(?:script|pre|style|textarea|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>|$))/i.test(
    line
  );
}

type MarkdownFence = { readonly delimiter: string; readonly indent: number };

function readMarkdownFenceOpening(line: string): MarkdownFence | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[2][0] === '`' && match[3].includes('`')))
    return undefined;
  return { delimiter: match[2], indent: match[1].length };
}

function closeMarkdownFence(fence: MarkdownFence): string {
  return ' '.repeat(fence.indent) + fence.delimiter;
}

function advanceMarkdownFence(
  line: string,
  fence: MarkdownFence | undefined
): {
  readonly fence?: MarkdownFence;
  readonly closing?: string;
  readonly normalized?: string;
} {
  if (fence) {
    const closer = /^( *)(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
    if (
      closer &&
      closer[2][0] === fence.delimiter[0] &&
      closer[2].length >= fence.delimiter.length &&
      closer[1].length <= fence.indent + 3
    )
      // Wider or dedented closers may cross a container boundary. Normalize
      // the physical line too, so GFM and our fence state cannot disagree.
      return {
        normalized:
          closer[1].length < fence.indent || closer[1].length > 3
            ? closeMarkdownFence(fence)
            : undefined,
      };
    // A container can end at a dedent even though a top-level fence would
    // continue. Close conservatively at the original indent before prose.
    if (!line.trim() || line.match(/^ */)![0].length >= fence.indent)
      return { fence };
    return {
      fence: readMarkdownFenceOpening(line),
      closing: closeMarkdownFence(fence),
    };
  }
  return { fence: readMarkdownFenceOpening(line) };
}

/** Split only at paragraph boundaries outside code fences. */
function markdownBlocks(value: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence: MarkdownFence | undefined;
  for (const original of value.split('\n')) {
    const next = advanceMarkdownFence(original, fence);
    const line = next.normalized ?? original;
    if (next.closing) lines.push(next.closing);
    fence = next.fence;
    if (!line.trim() && !fence) {
      if (lines.length) blocks.push(lines.join('\n'));
      lines = [];
    } else lines.push(line);
  }
  if (fence) lines.push(closeMarkdownFence(fence));
  if (lines.length) blocks.push(lines.join('\n'));
  return blocks;
}

function singleLineText(value: string): string {
  return Array.from(value, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? ' ' : char;
  }).join('');
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function safeFindingBody(value: string): string {
  // Escape prose HTML, preserve code, and neutralize attempts to close the
  // generated disclosures. The original body remains in the JSON artifact.
  let fence: MarkdownFence | undefined;
  const lines: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) lines.push(escapeHtmlOutsideCodeSpans(prose.join('\n')));
    prose = [];
  };
  for (const line of neutralizeDetailsMarkup(value).split('\n')) {
    const previous = fence;
    const next = advanceMarkdownFence(line, fence);
    fence = next.fence;
    if (previous && !next.closing) {
      lines.push(next.normalized ?? line);
      continue;
    }
    if (next.closing) lines.push(next.closing);
    if (fence) {
      flush();
      lines.push(line);
    } else if (markdownInterruptsParagraph(line)) {
      // A block interruptor ends a paragraph even without a blank line. Never
      // preserve raw HTML through backticks that GFM cannot match across it.
      flush();
      lines.push(escapeHtmlOutsideCodeSpans(line));
    } else prose.push(line);
  }
  flush();
  return markdownBlocks(lines.join('\n')).join('\n\n');
}

function escapeHtmlOutsideCodeSpans(value: string): string {
  const escape = (text: string) =>
    text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  // Code spans can cross soft breaks, but never a paragraph or fenced block.
  return value
    .split(/(\r?\n[ \t]*\r?\n)/)
    .map((paragraph) => {
      const ticks = Array.from(paragraph.matchAll(/`+/g));
      let result = '';
      let cursor = 0;
      for (let index = 0; index < ticks.length; index++) {
        const opening = ticks[index]!;
        let slashes = 0;
        for (
          let position = opening.index! - 1;
          position >= 0 && paragraph[position] === '\\';
          position--
        )
          slashes++;
        const start = opening.index! + (slashes % 2);
        const delimiterLength = opening[0].length - (slashes % 2);
        if (delimiterLength === 0) continue;
        const closing = ticks.findIndex(
          (tick, candidate) =>
            candidate > index && tick[0].length === delimiterLength
        );
        if (closing < 0) continue;
        const end = ticks[closing]!.index! + ticks[closing]![0].length;
        result +=
          escape(paragraph.slice(cursor, start)) + paragraph.slice(start, end);
        cursor = end;
        index = closing;
      }
      return result + escape(paragraph.slice(cursor));
    })
    .join('');
}

function renderReviewerBanner(
  input: ReviewerSummaryInput,
  incomplete: boolean,
  counts: SeverityCounts
): string {
  return renderReviewBanner(
    input.bannerBaseUrl,
    input.reviewPresentation ?? {
      variant: 'first',
      state: incomplete ? 'incomplete' : 'complete',
      severity: {
        critical: counts.critical + (input.previousCounts?.critical ?? 0),
        major: counts.major + (input.previousCounts?.major ?? 0),
        minor: counts.minor + (input.previousCounts?.minor ?? 0),
        info: 0,
      },
      ...(input.coverage
        ? {
            coverage: {
              reviewed: input.coverage.reviewedFiles,
              total: input.coverage.totalFiles,
            },
          }
        : {}),
    }
  );
}
