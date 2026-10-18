import { Finding, Review, ReviewMetrics, Severity } from '../types';
import { isLinkedCurrentFinding } from '../analysis/thread-lifecycle';
import { countMaxConsecutiveBackticks } from '../utils/suggestion-formatter';

export const REVIEW_SUMMARY_STATUS_COMPLETE_MARKER =
  '<!-- reviewrouter:review-status:complete -->';
export const REVIEW_SUMMARY_STATUS_INCOMPLETE_MARKER =
  '<!-- reviewrouter:review-status:incomplete -->';

const statusHeadingMarker = '<!-- reviewrouter:summary-status -->';
const maxSummaryBytes = 60_000;
const maxFindingBodyChars = 2_500;

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

type ReviewerSummaryCopy = {
  readonly noFindingsHeading: string;
  readonly limitedNoFindingsHeading: string;
  readonly dismissedNote: (count: number) => string;
  readonly findingsHeading: (input: SeverityCounts) => string;
  readonly providerFailures: (failed: number, planned: number) => string;
  readonly location: string;
  readonly fix: string;
  readonly incompleteHeading: (count: number) => string;
  readonly incompleteNote: string;
  readonly coverageHeading: string;
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
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = '\n\n[truncated]';
  const budget = Math.max(0, maxChars - suffix.length);
  return `${dropIncompleteDetails(value.slice(0, budget)).trimEnd()}${suffix}`;
}

export function neutralizeDetailsMarkup(value: string): string {
  return value.replace(/<\/?(?:details|summary)\b[^>]*>/gi, (tag) =>
    tag.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  );
}

export type ReviewerSummaryInput = {
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
  readonly incomplete?: boolean;
  readonly coverage?: { readonly complete: boolean };
  readonly metrics: Pick<ReviewMetrics, 'providersUsed' | 'providersSuccess'>;
}): boolean {
  return (
    input.incomplete === true ||
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
    total: input.metrics.totalFindings,
    critical: input.metrics.critical,
    major: input.metrics.major,
    minor: input.metrics.minor,
  };
  const previous = input.previousCounts;
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
  const heading = incomplete
    ? copy.incompleteHeading(counts.total)
    : counts.total > 0
      ? copy.findingsHeading(counts)
      : historical
        ? `## ${labels.previous}`
        : input.dismissedFindings
          ? `## ${labels.dismissed}`
          : limitedScope
            ? copy.limitedNoFindingsHeading
            : copy.noFindingsHeading;
  const lines = [
    incomplete
      ? REVIEW_SUMMARY_STATUS_INCOMPLETE_MARKER
      : REVIEW_SUMMARY_STATUS_COMPLETE_MARKER,
    `<!-- reviewrouter:summary-locale:${locale} -->`,
    '# ReviewRouter',
    '',
    (['critical', 'major', 'minor'] as const)
      .map((severity, i) => {
        const count = counts[severity] + (previous?.[severity] ?? 0);
        return `${['🔴', '🟡', '🔵'][i]} **${count} ${severity}**`;
      })
      .join(' · '),
    '',
    `## ${labels.summary}`,
    '',
    statusHeadingMarker,
    heading,
  ];
  if (incomplete) lines.push('', copy.incompleteNote);
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
  if (input.coverage) {
    const coverage = input.coverage;
    lines.push(
      '',
      '<details>',
      `<summary>${labels.scope}</summary>`,
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
      lines.push(
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
        lines.push(`| ${scopeCopy[locale][key]} | ${value} |`);
    }
    if (coverage.agenticContext !== undefined)
      lines.push(
        `| ${scopeCopy[locale].context} | ${coverage.agenticContext ? '✓' : '—'} |`
      );
    lines.push('');
    if (!coverage.complete) lines.push(copy.coverageHeading, '');
    lines.push(
      ...coverage.limitations.map((value) => `- ${escapeMarkdownText(value)}`)
    );
    for (const file of (coverage.files ?? [])
      .filter((file) => file.status !== 'full')
      .slice(0, 20))
      lines.push(
        `- \`${escapeMarkdownInline(file.path)}\` - ${escapeMarkdownText(file.status)}${file.reason ? ` — ${escapeMarkdownText(file.reason)}` : ''}`
      );
    lines.push('', '</details>');
  }
  const releaseNotes = input.findings.filter(
    (finding) => finding.category && finding.severity !== 'minor'
  );
  if (releaseNotes.length) {
    lines.push('', `## ${scopeCopy[locale].release}`);
    for (const category of new Set(
      releaseNotes.map((finding) => finding.category!)
    )) {
      lines.push(
        '',
        `**${escapeMarkdownText(category)}:**`,
        ...releaseNotes
          .filter((finding) => finding.category === category)
          .map(
            (finding) =>
              `- ${finding.severity === 'critical' ? '🔴' : '🟡'} ${escapeMarkdownText(finding.title)}`
          )
      );
    }
  }
  if (input.findings.length > 0) lines.push('', `## ${labels.findings}`);
  const remaining: string[] = [];
  for (const finding of [...input.findings].sort(compareSummaryFindings)) {
    const block = renderFindingDetails(copy, finding);
    if (utf8Bytes([...lines, '', block].join('\n')) > maxSummaryBytes - 2_000) {
      remaining.push(compactFindingLine(finding));
    } else lines.push('', block);
  }
  if (remaining.length > 0)
    lines.push('', copy.moreFindings(remaining.length), ...remaining);
  if (input.lifecycle?.length)
    lines.push(
      '',
      `## ${labels.previous}`,
      '',
      renderReviewerLifecycleMarkdown({
        language: input.language,
        lines: input.lifecycle,
      })
    );
  if (input.lifecycleAttention)
    lines.push(
      '',
      `**${labels.attention}**`,
      ...(input.lifecycleWarnings ?? []).map(
        (value) => `- ${escapeMarkdownText(value)}`
      )
    );
  const measured = input.measurements;
  lines.push(
    '',
    '<details>',
    `<summary>${labels.performance}</summary>`,
    '',
    `| ${labels.metric} | ${labels.value} |`,
    '|---|---:|',
    `| ${labels.providers} | ${input.metrics.providersSuccess}/${input.metrics.providersUsed} |`
  );
  if (measured?.durationSeconds !== undefined)
    lines.push(
      `| ${labels.duration} | ${measured.durationSeconds.toFixed(2)}s |`
    );
  if (measured?.tokens !== undefined)
    lines.push(
      `| ${labels.tokens} | ${measured.tokens.toLocaleString('en-US')} |`
    );
  if (measured?.cost !== undefined)
    lines.push(`| ${labels.cost} | $${measured.cost.toFixed(4)} |`);
  else
    lines.push(
      `| ${scopeCopy[locale].billing} | ${scopeCopy[locale].unknown} |`
    );
  if (measured?.cacheHit) lines.push(`| ${labels.cache} | ✓ |`);
  if (measured?.providers?.length)
    lines.push('', `**${scopeCopy[locale].providerPerformance}:**`);
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
    lines.push(
      '',
      `- ${icon} **${escapeMarkdownText(provider.name)}${provider.requiredHealthy ? ` (${scopeCopy[locale].required})` : ''}** (${facts.join(', ')})`
    );
    if (provider.errorMessage)
      lines.push(`  ${escapeMarkdownText(provider.errorMessage)}`);
  }
  lines.push('', '</details>');
  if (input.analysis) {
    const analysis = input.analysis;
    lines.push(
      '',
      '<details>',
      `<summary>${labels.analysis}</summary>`,
      '',
      `${(analysis.averageLikelihood * 100).toFixed(1)}% · ${escapeMarkdownText(analysis.consensus)}`,
      ...Object.entries(analysis.providerEstimates).map(
        ([name, likelihood]) =>
          `- ${escapeMarkdownText(name)}: ${(likelihood * 100).toFixed(1)}%`
      ),
      '',
      '</details>'
    );
  }
  if (input.diagram?.trim() && /(?:-->|---|-.->|==>)/.test(input.diagram)) {
    lines.push(
      '',
      '<details>',
      `<summary>${labels.impact}</summary>`,
      '',
      formatCodeFence(neutralizeDetailsMarkup(input.diagram), 'mermaid'),
      '',
      '</details>'
    );
  }
  if (input.testHints?.length)
    lines.push(
      '',
      '<details>',
      `<summary>${scopeCopy[locale].tests}</summary>`,
      '',
      ...input.testHints.map(
        (hint) =>
          `- \`${escapeMarkdownInline(hint.file)}\` → \`${escapeMarkdownInline(hint.suggestedTestFile)}\`: ${escapeMarkdownText(hint.testPattern)}`
      ),
      '',
      '</details>'
    );
  const measuredFooter = [
    measured?.durationSeconds !== undefined
      ? `${measured.durationSeconds.toFixed(1)}s`
      : '',
    measured?.cost !== undefined ? `$${measured.cost.toFixed(4)}` : '',
  ].filter(Boolean);
  lines.push(
    '',
    '---',
    '',
    `<sub>${[...measuredFooter, 'Powered by ReviewRouter'].join(' • ')}</sub>`
  );
  return limitUtf8(lines.join('\n'), maxSummaryBytes);
}

/** Legacy compatibility mapping only; presentation stays in the normalized renderer. */
export function renderReviewSummary(review: Review, language?: string): string {
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
      `${label} · ${line.locationLabel} · ${line.title}`.trim()
    );
    const body = [
      neutralizeDetailsMarkup(line.message.trim()),
      line.locationLabel,
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
    .replace(new RegExp(`${status}## [^\\n]+`), `${status}${heading}`);
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
  return finding.startLine !== undefined &&
    finding.endLine !== undefined &&
    finding.startLine < finding.endLine
    ? `${finding.file}:${finding.startLine}-${finding.endLine}`
    : `${finding.file}:${finding.line}`;
}

function renderFindingDetails(
  copy: ReviewerSummaryCopy,
  finding: ReviewerSummaryFinding
): string {
  const location = findingLocationLabel(finding);
  const summary = escapeHtml(
    `${finding.severity} · ${location} · ${finding.title.trim()}`
  );
  const message = truncateChars(
    neutralizeDetailsMarkup(finding.message.trim()),
    maxFindingBodyChars
  );
  const parts = [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    message,
    '',
    `**${copy.location}:** \`${escapeMarkdownInline(location)}\``,
  ];
  if (finding.suggestion?.trim()) {
    parts.push(
      '',
      `**${copy.fix}**`,
      '',
      formatCodeFence(finding.suggestion.trim())
    );
  }
  if (finding.evidence)
    parts.push(
      '',
      `**Evidence:** ${escapeMarkdownText(finding.evidence.badge)} (${Math.round(finding.evidence.confidence * 100)}%)`,
      '',
      neutralizeDetailsMarkup(finding.evidence.reasoning ?? '')
    );
  if (finding.attribution?.length)
    parts.push(
      '',
      finding.attribution.length === 1
        ? `<sub>Model: ${escapeHtml(finding.attribution[0])}</sub>`
        : `<sub>Models: ${escapeHtml(finding.attribution.join(', '))} · agreement ${finding.attribution.length}/${Math.max(finding.attributionPoolSize ?? finding.attribution.length, finding.attribution.length)}</sub>`
    );
  parts.push('', '</details>');
  return parts.join('\n');
}

function compactFindingLine(finding: ReviewerSummaryFinding): string {
  return `- **${finding.severity}** \`${escapeMarkdownInline(findingLocationLabel(finding))}\` ${escapeMarkdownInline(finding.title.trim())}`;
}

function compareSummaryFindings(
  left: ReviewerSummaryFinding,
  right: ReviewerSummaryFinding
): number {
  const rank: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };
  return (
    rank[right.severity] - rank[left.severity] ||
    left.file.localeCompare(right.file) ||
    left.line - right.line
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

const copies: Record<ReviewerSummaryLocale, ReviewerSummaryCopy> = {
  en: {
    noFindingsHeading: '## No findings',
    limitedNoFindingsHeading: '## No reportable findings in reviewed files',
    dismissedNote: (count) =>
      `${count} ${count === 1 ? 'finding' : 'findings'} dismissed by maintainer/admin \`/rr skip\` ${count === 1 ? 'override' : 'overrides'}.`,
    findingsHeading: (counts) =>
      `## ${counts.total} ${englishFindingWord(counts.total)} (${formatSeverityCounts(counts)})`,
    providerFailures: (failed, planned) =>
      `${failed} of ${planned} review providers failed.`,
    location: 'Location',
    fix: 'Fix',
    incompleteHeading: (count) =>
      `## Review incomplete — ${count} preliminary ${englishFindingWord(count)}`,
    incompleteNote:
      'Inline comments and lifecycle changes were withheld because required coverage did not complete.',
    coverageHeading: '### Coverage not completed',
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
    providerFailures: (failed, planned) =>
      `Не сработали ${failed} из ${planned} провайдеров ревью.`,
    location: 'Место',
    fix: 'Исправление',
    incompleteHeading: (count) =>
      `## Ревью не завершено — ${count} ${slavicFindingWord(count, ['предварительное замечание', 'предварительных замечания', 'предварительных замечаний'])}`,
    incompleteNote:
      'Инлайн-комментарии и изменения lifecycle не публиковались: покрытие ревью не завершено.',
    coverageHeading: '### Покрытие не завершено',
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
    providerFailures: (failed, planned) =>
      `Не спрацювали ${failed} з ${planned} провайдерів рев’ю.`,
    location: 'Місце',
    fix: 'Виправлення',
    incompleteHeading: (count) =>
      `## Рев’ю не завершено — ${count} ${slavicFindingWord(count, ['попереднє зауваження', 'попередні зауваження', 'попередніх зауважень'])}`,
    incompleteNote:
      'Інлайн-коментарі та зміни lifecycle не публікувалися: покриття рев’ю не завершено.',
    coverageHeading: '### Покриття не завершено',
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
    providerFailures: (failed, planned) =>
      `Fallaron ${failed} de ${planned} proveedores de revisión.`,
    location: 'Ubicación',
    fix: 'Corrección',
    incompleteHeading: (count) =>
      `## Revisión incompleta — ${count} ${count === 1 ? 'hallazgo preliminar' : 'hallazgos preliminares'}`,
    incompleteNote:
      'No se publicaron comentarios en línea ni cambios de ciclo de vida porque la cobertura no se completó.',
    coverageHeading: '### Cobertura incompleta',
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
    providerFailures: (failed, planned) =>
      `${failed} de ${planned} provedores de revisão falharam.`,
    location: 'Local',
    fix: 'Correção',
    incompleteHeading: (count) =>
      `## Revisão incompleta — ${count} ${count === 1 ? 'achado preliminar' : 'achados preliminares'}`,
    incompleteNote:
      'Comentários inline e mudanças de ciclo de vida não foram publicados porque a cobertura não foi concluída.',
    coverageHeading: '### Cobertura não concluída',
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
    providerFailures: (failed, planned) =>
      `${failed} fournisseur(s) de revue sur ${planned} ont échoué.`,
    location: 'Emplacement',
    fix: 'Correctif',
    incompleteHeading: (count) =>
      `## Revue incomplète — ${count} ${count === 1 ? 'anomalie préliminaire' : 'anomalies préliminaires'}`,
    incompleteNote:
      'Les commentaires inline et les changements de cycle de vie n’ont pas été publiés car la couverture est incomplète.',
    coverageHeading: '### Couverture incomplète',
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
    providerFailures: (failed, planned) =>
      `${failed} von ${planned} Review-Providern sind fehlgeschlagen.`,
    location: 'Stelle',
    fix: 'Fix',
    incompleteHeading: (count) =>
      `## Review unvollständig — ${count} vorläufige ${count === 1 ? 'Befund' : 'Befunde'}`,
    incompleteNote:
      'Inline-Kommentare und Lifecycle-Änderungen wurden nicht veröffentlicht, weil die Abdeckung unvollständig ist.',
    coverageHeading: '### Abdeckung unvollständig',
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
    providerFailures: (failed, planned) =>
      `${failed} di ${planned} provider di review non sono riusciti.`,
    location: 'Posizione',
    fix: 'Correzione',
    incompleteHeading: (count) =>
      `## Review incompleta — ${count} ${count === 1 ? 'rilievo preliminare' : 'rilievi preliminari'}`,
    incompleteNote:
      'I commenti inline e le modifiche di lifecycle non sono stati pubblicati perché la copertura non è completa.',
    coverageHeading: '### Copertura non completata',
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
    providerFailures: (failed, planned) =>
      `${planned} 个审查提供方中有 ${failed} 个失败。`,
    location: '位置',
    fix: '修复',
    incompleteHeading: (count) => `## 审查未完成 — 保留 ${count} 条初步问题`,
    incompleteNote: '因覆盖未完成，未发布行内评论和生命周期变更。',
    coverageHeading: '### 覆盖未完成',
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
    providerFailures: (failed, planned) =>
      `レビュープロバイダー ${planned} 件中 ${failed} 件が失敗しました。`,
    location: '場所',
    fix: '修正',
    incompleteHeading: (count) => `## レビュー未完了 — 暫定の指摘 ${count} 件`,
    incompleteNote:
      'カバレッジが完了していないため、インラインコメントとライフサイクル変更は投稿していません。',
    coverageHeading: '### カバレッジ未完了',
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
    providerFailures: (failed, planned) =>
      `리뷰 제공자 ${planned}개 중 ${failed}개가 실패했습니다.`,
    location: '위치',
    fix: '수정',
    incompleteHeading: (count) => `## 리뷰 미완료 — 예비 이슈 ${count}개`,
    incompleteNote:
      '커버리지가 끝나지 않아 인라인 댓글과 라이프사이클 변경을 게시하지 않았습니다.',
    coverageHeading: '### 커버리지 미완료',
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

function escapeMarkdownInline(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`');
}

function dropIncompleteDetails(value: string): string {
  const openTags = Array.from(value.matchAll(/<details\b[^>]*>/gi));
  const closeTags = Array.from(value.matchAll(/<\/details>/gi));
  if (openTags.length <= closeTags.length) {
    return value;
  }
  const lastOpen = openTags[openTags.length - 1];
  if (lastOpen?.index === undefined) {
    return value;
  }
  return value.slice(0, lastOpen.index).trimEnd();
}

function limitUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) {
    return value;
  }
  const suffix = '\n\n[truncated]';
  const budget = Math.max(0, maxBytes - utf8Bytes(suffix));
  let cut = Buffer.from(value, 'utf8').subarray(0, budget).toString('utf8');
  if (cut.endsWith('\uFFFD')) {
    cut = cut.slice(0, -1);
  }
  return `${dropIncompleteDetails(cut).trimEnd()}${suffix}`;
}

function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 12).trimEnd()}\n\n[truncated]`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
