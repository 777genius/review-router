import { Finding, ReviewMetrics, Severity } from '../types';
import { countMaxConsecutiveBackticks } from '../utils/suggestion-formatter';

export const REVIEW_SUMMARY_STATUS_COMPLETE_MARKER =
  '<!-- reviewrouter:review-status:complete -->';
export const REVIEW_SUMMARY_STATUS_INCOMPLETE_MARKER =
  '<!-- reviewrouter:review-status:incomplete -->';

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
};

export type ReviewerLifecycleLine = {
  readonly kind: 'resolved' | 'carried' | 'uncertain' | 'suppressed';
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

export function renderReviewerSummaryMarkdown(input: {
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
}): string {
  const copy = reviewerSummaryCopy(input.language);
  const counts: SeverityCounts = {
    total: input.metrics.totalFindings,
    critical: input.metrics.critical,
    major: input.metrics.major,
    minor: input.metrics.minor,
  };
  const failedProviders = Math.max(
    0,
    input.metrics.providersUsed - input.metrics.providersSuccess
  );
  const heading = input.incomplete
    ? copy.incompleteHeading(counts.total)
    : counts.total === 0
      ? copy.noFindingsHeading
      : copy.findingsHeading(counts);
  const lines: string[] = [
    input.incomplete
      ? REVIEW_SUMMARY_STATUS_INCOMPLETE_MARKER
      : REVIEW_SUMMARY_STATUS_COMPLETE_MARKER,
    heading,
  ];
  if (input.incomplete) {
    lines.push('', copy.incompleteNote);
  }
  if (failedProviders > 0) {
    lines.push(
      '',
      copy.providerFailures(failedProviders, input.metrics.providersUsed)
    );
  }

  const sorted = [...input.findings].sort(compareSummaryFindings);
  const remaining: string[] = [];
  for (const finding of sorted) {
    const block = renderFindingDetails(copy, finding);
    const candidate = [...lines, '', block];
    if (utf8Bytes(candidate.join('\n')) > maxSummaryBytes) {
      remaining.push(compactFindingLine(finding));
      continue;
    }
    lines.push('', block);
  }

  if (remaining.length > 0) {
    const header = ['', copy.moreFindings(remaining.length)];
    if (utf8Bytes([...lines, ...header].join('\n')) <= maxSummaryBytes) {
      lines.push(...header);
      for (const compact of remaining) {
        const candidate = [...lines, compact];
        if (utf8Bytes(candidate.join('\n')) > maxSummaryBytes) {
          break;
        }
        lines.push(compact);
      }
    }
  }

  return limitUtf8(lines.join('\n'), maxSummaryBytes);
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
  const rewritten = input.summary
    .replace(
      REVIEW_SUMMARY_STATUS_COMPLETE_MARKER,
      REVIEW_SUMMARY_STATUS_INCOMPLETE_MARKER
    )
    .replace(/^## .+$/m, heading);
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

function formatCodeFence(content: string): string {
  const fence = '`'.repeat(
    Math.max(3, countMaxConsecutiveBackticks(content) + 1)
  );
  return `${fence}\n${content.trimEnd()}\n${fence}`;
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
      carried: 'carried, not revalidated',
      uncertain: 'needs attention',
      suppressed: 'suppressed',
    },
  },
  ru: {
    noFindingsHeading: '## Замечаний нет',
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
      carried: 'перенесено, не перепроверено',
      uncertain: 'нужно внимание',
      suppressed: 'скрыто',
    },
  },
  uk: {
    noFindingsHeading: '## Зауважень немає',
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
      carried: 'перенесено, не перевірено знову',
      uncertain: 'потрібна увага',
      suppressed: 'приховано',
    },
  },
  es: {
    noFindingsHeading: '## Sin hallazgos',
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
      carried: 'arrastrado, no revalidado',
      uncertain: 'requiere atención',
      suppressed: 'omitido',
    },
  },
  pt: {
    noFindingsHeading: '## Nenhum achado',
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
      carried: 'carregado, não revalidado',
      uncertain: 'precisa de atenção',
      suppressed: 'suprimido',
    },
  },
  fr: {
    noFindingsHeading: '## Aucune anomalie',
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
      carried: 'reporté, non revalidé',
      uncertain: 'nécessite une attention',
      suppressed: 'masqué',
    },
  },
  de: {
    noFindingsHeading: '## Keine Befunde',
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
      resolved: 'erledigt',
      carried: 'übernommen, nicht erneut geprüft',
      uncertain: 'braucht Aufmerksamkeit',
      suppressed: 'unterdrückt',
    },
  },
  it: {
    noFindingsHeading: '## Nessun rilievo',
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
      carried: 'riportato, non rivalidato',
      uncertain: 'richiede attenzione',
      suppressed: 'soppresso',
    },
  },
  zh: {
    noFindingsHeading: '## 无问题',
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
      carried: '沿用，未复验',
      uncertain: '需要关注',
      suppressed: '已抑制',
    },
  },
  ja: {
    noFindingsHeading: '## 指摘なし',
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
      carried: '持ち越し、再検証なし',
      uncertain: '要確認',
      suppressed: '抑制済み',
    },
  },
  ko: {
    noFindingsHeading: '## 이슈 없음',
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
      carried: '이월됨, 재검증 안 함',
      uncertain: '확인 필요',
      suppressed: '숨김',
    },
  },
};

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
