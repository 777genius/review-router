import { LifecycleThreadRecord, Review, Finding } from '../types';
import {
  countPreviousStillValidBySeverity,
  hasLifecycleUncertainty,
  isLinkedCurrentFinding,
} from '../analysis/thread-lifecycle';
import { getSeverityDisplay, severityLine } from '../utils/severity';

/**
 * Enhanced Markdown Formatter
 * Inspired by Claude Code Action and CodeRabbit
 * Features:
 * - Clean, professional formatting
 * - Visual severity indicators (🔴 🟡 🔵)
 * - PR summary and release notes
 * - Collapsible sections
 * - Minimal emoji usage
 */
export class MarkdownFormatterV2 {
  format(review: Review): string {
    const lines: string[] = [];

    // Header with branding
    lines.push('# ReviewRouter');
    lines.push('');

    // Finding stats summary
    lines.push(this.formatQuickStats(review));
    lines.push('');

    // PR Summary section
    lines.push('## Summary');
    lines.push('');
    lines.push(`> ${this.generatePRSummary(review)}`);
    lines.push('');

    const reviewScope = this.formatReviewScope(review);
    if (reviewScope) {
      lines.push(reviewScope);
      lines.push('');
    }

    const releaseNotes = this.generateReleaseNotes(review).trim();
    if (releaseNotes) {
      lines.push('## Release Notes');
      lines.push('');
      lines.push(releaseNotes);
      lines.push('');
    }

    // Findings by severity with visual indicators
    const hasFindings = review.findings.length > 0;
    const lifecycleSection = this.formatThreadLifecycle(review);

    if (hasFindings) {
      lines.push('## Findings');
      lines.push('');

      const critical = review.findings.filter((f) => f.severity === 'critical');
      const major = review.findings.filter((f) => f.severity === 'major');
      const minor = review.findings.filter((f) => f.severity === 'minor');

      if (critical.length > 0) {
        lines.push(
          this.formatSeveritySection('🔴 Critical', critical, 'critical')
        );
      }

      if (major.length > 0) {
        lines.push(this.formatSeveritySection('🟡 Major', major, 'major'));
      }

      if (minor.length > 0) {
        lines.push(this.formatSeveritySection('🔵 Minor', minor, 'minor'));
      }
    }

    if (lifecycleSection) {
      lines.push(lifecycleSection);
      lines.push('');
    }

    if (hasFindings || lifecycleSection) {
      // Findings or unresolved lifecycle state already explain the status.
    } else if (this.didAllProviderRunsFail(review)) {
      lines.push('## Review Incomplete');
      lines.push('');
      lines.push(`> ${this.generateAllClearMessage(review)}`);
      lines.push('');
    } else if (this.hasDismissedFindings(review)) {
      lines.push('## No Active Findings');
      lines.push('');
      lines.push(`> ${this.generateAllClearMessage(review)}`);
      lines.push('');
    } else {
      // Only emit one “clear” block; avoid repeating the no-providers message
      const allClearMessage = this.generateAllClearMessage(review, {
        suppressRepeat: true,
      });
      lines.push('## All Clear!');
      lines.push('');
      lines.push(`> ${allClearMessage}`);
      lines.push('');
    }

    // Performance & metrics
    lines.push(this.formatMetrics(review));
    lines.push('');

    // Advanced sections (collapsible)
    lines.push(this.formatAdvancedSections(review));

    // Footer
    lines.push('---');
    lines.push('');
    lines.push(this.formatFooter(review));

    return lines.join('\n');
  }

  private formatQuickStats(review: Review): string {
    const { metrics } = review;
    const previous = countPreviousStillValidBySeverity(review.threadLifecycle);
    const criticalCount = metrics.critical + previous.critical;
    const majorCount = metrics.major + previous.major;
    const minorCount = metrics.minor + previous.minor;

    const criticalBadge =
      criticalCount > 0
        ? `🔴 **${criticalCount} Critical**`
        : `~~${criticalCount} Critical~~`;
    const majorBadge =
      majorCount > 0 ? `🟡 **${majorCount} Major**` : `~~${majorCount} Major~~`;
    const minorBadge =
      minorCount > 0 ? `🔵 ${minorCount} Minor` : `~~${minorCount} Minor~~`;
    const parts = [criticalBadge, majorBadge, minorBadge];

    return parts.join(' • ');
  }

  private formatRunSummary(review: Review): string {
    const { metrics } = review;
    const parts = [`${metrics.durationSeconds.toFixed(1)}s`];

    if (this.shouldHideApiBilling(review)) {
      parts.push('OAuth subscription');
    } else if (this.hasMeasuredApiBilling(review)) {
      parts.push(`$${metrics.totalCost.toFixed(4)}`);
    }

    return parts.join(' • ');
  }

  private generatePRSummary(review: Review): string {
    const { metrics, findings } = review;
    const previous = countPreviousStillValidBySeverity(review.threadLifecycle);
    const previousActive =
      previous.critical + previous.major + previous.minor;

    if (findings.length === 0) {
      if (previousActive > 0) {
        return `No new current findings, but ${previousActive} previous unresolved ReviewRouter finding${previousActive === 1 ? '' : 's'} still appear valid and remain active.`;
      }
      if (hasLifecycleUncertainty(review.threadLifecycle)) {
        return 'No new current findings, but previous unresolved ReviewRouter threads could not be safely reconciled. See Previous Review Threads.';
      }
      if (this.didAllProviderRunsFail(review)) {
        return 'LLM review did not complete because all configured providers failed. Static checks did not find issues. See Performance Metrics for the provider error.';
      }
      if (metrics.providersSuccess === 0) {
        return 'LLM review skipped: no healthy providers were available. Static checks did not find issues.';
      }
      if (this.hasDismissedFindings(review)) {
        const count = metrics.dismissedFindings ?? 0;
        const noun = count === 1 ? 'finding' : 'findings';
        const verb = count === 1 ? 'was' : 'were';
        const override = count === 1 ? 'override' : 'overrides';
        return `No active findings. ${count} ${noun} ${verb} dismissed by maintainer/admin \`/rr skip\` ${override}.`;
      }
      if (this.hasScopeLimitations(review)) {
        return 'No issues detected in reviewed files. Some files were compacted or metadata-only; see Review Scope.';
      }
      return 'This PR looks great! No issues detected by the automated review.';
    }

    const parts: string[] = [];

    if (metrics.critical > 0) {
      const verb = metrics.critical === 1 ? 'requires' : 'require';
      parts.push(
        `**${metrics.critical} critical issue${metrics.critical > 1 ? 's' : ''}** ${verb} immediate attention`
      );
    }

    if (metrics.major > 0) {
      parts.push(
        `${metrics.major} major issue${metrics.major > 1 ? 's' : ''} should be addressed`
      );
    }

    if (metrics.minor > 0) {
      parts.push(
        `${metrics.minor} minor improvement${metrics.minor > 1 ? 's' : ''} suggested`
      );
    }

    if (previousActive > 0) {
      parts.push(
        `${previousActive} previous unresolved finding${previousActive === 1 ? '' : 's'} still valid`
      );
    }

    const summary = parts.join(', ');

    // Add context about review scope and inline thread collapsing.
    const filesReviewed = new Set(findings.map((f) => f.file)).size;
    const context = `Found across ${filesReviewed} file${filesReviewed > 1 ? 's' : ''}.`;
    const locationCount = this.countFindingLocations(findings);
    const inlineContext =
      locationCount < findings.length
        ? ` Inline comments collapse same-line findings, so ${findings.length} findings map to ${locationCount} code thread${locationCount === 1 ? '' : 's'}.`
        : '';

    return `${summary}. ${context}${inlineContext}`;
  }

  private generateAllClearMessage(
    review: Review,
    options: { suppressRepeat?: boolean } = {}
  ): string {
    const { metrics } = review;
    if (this.didAllProviderRunsFail(review)) {
      return 'No issues were found by static checks, but LLM review did not complete because all configured providers failed.';
    }
    if (metrics.providersSuccess === 0) {
      return options.suppressRepeat
        ? 'LLM analysis skipped because no providers were healthy.'
        : 'LLM analysis skipped because no providers were healthy. Static checks found no issues.';
    }
    if (this.hasDismissedFindings(review)) {
      const count = metrics.dismissedFindings ?? 0;
      return `${count} finding${count === 1 ? '' : 's'} dismissed by maintainer/admin \`/rr skip\` override${count === 1 ? '' : 's'}. No active findings remain.`;
    }
    if (this.hasScopeLimitations(review)) {
      return 'No issues found in reviewed files. Some files were compacted or metadata-only; see Review Scope.';
    }
    return 'No issues found. Great job!';
  }

  private formatReviewScope(review: Review): string {
    const coverage = review.coverage;
    if (!coverage) return '';

    const lines: string[] = [];
    const limitedFiles = coverage.files.filter(
      (file) =>
        file.status === 'compacted' ||
        file.status === 'metadata-only' ||
        file.status === 'skipped'
    );

    lines.push('<details>');
    lines.push('<summary>Review Scope</summary>');
    lines.push('');
    lines.push('| Scope | Count |');
    lines.push('|-------|------:|');
    lines.push(`| Total PR files | ${coverage.totalFiles} |`);
    lines.push(
      `| Files considered by reviewer | ${coverage.filesConsidered} |`
    );
    lines.push(`| Full diff in prompt | ${coverage.fullDiffFiles} |`);
    lines.push(`| Compacted in prompt | ${coverage.compactedFiles} |`);
    lines.push(`| Metadata-only or trimmed | ${coverage.metadataOnlyFiles} |`);
    lines.push(`| Skipped before LLM review | ${coverage.skippedFiles} |`);
    lines.push(
      `| Codex agentic context | ${coverage.agenticContext ? 'Enabled for Codex providers' : 'Disabled'} |`
    );
    lines.push(`| Review mode | ${coverage.mode} |`);

    if (limitedFiles.length > 0) {
      lines.push('');
      lines.push('Files not shown as full diffs in the primary prompt:');
      lines.push('');
      limitedFiles.slice(0, 20).forEach((file) => {
        const reason = file.reason ? ` - ${file.reason}` : '';
        lines.push(`- \`${file.path}\` - ${file.status}${reason}`);
      });
      if (limitedFiles.length > 20) {
        lines.push(`- ...and ${limitedFiles.length - 20} more`);
      }
      lines.push('');
      lines.push(
        'Codex providers with agentic context can inspect related files read-only during review. This section is still shown so a "no findings" result on a large PR is auditable.'
      );
    }

    lines.push('');
    lines.push('</details>');

    return lines.join('\n');
  }

  private generateReleaseNotes(review: Review): string {
    const lines: string[] = [];
    const significant = review.findings.filter(
      (f) => f.severity === 'critical' || f.severity === 'major'
    );

    if (significant.length === 0) return '';

    // Group by category (skip findings without category)
    const byCategory = new Map<string, Finding[]>();
    significant.forEach((f) => {
      if (!f.category) return; // Skip findings without category
      if (!byCategory.has(f.category)) {
        byCategory.set(f.category, []);
      }
      byCategory.get(f.category)!.push(f);
    });

    byCategory.forEach((findings, category) => {
      lines.push(`**${category}:**`);
      findings.forEach((f) => {
        const emoji = f.severity === 'critical' ? '🔴' : '🟡';
        lines.push(`- ${emoji} ${f.title}`);
      });
      lines.push('');
    });

    return lines.join('\n').trim();
  }

  private formatSeveritySection(
    header: string,
    findings: Finding[],
    severity: 'critical' | 'major' | 'minor'
  ): string {
    const lines: string[] = [];

    lines.push(`### ${header} (${findings.length})`);
    lines.push('');

    findings.forEach((finding, index) => {
      // Pass the index and total count for numbering (if count > 1)
      lines.push(
        this.formatFinding(finding, severity, index + 1, findings.length)
      );
      if (index < findings.length - 1) {
        lines.push('');
      }
    });

    lines.push('');

    return lines.join('\n');
  }

  private formatFinding(
    finding: Finding,
    severity: 'critical' | 'major' | 'minor',
    index: number,
    total: number
  ): string {
    const lines: string[] = [];

    // Finding header with collapsible details
    const display = getSeverityDisplay(severity);
    const location = `\`${finding.file}:${finding.line}\``;

    // Add number prefix if there are multiple findings of this severity
    const numberPrefix = total > 1 ? `${index}. ` : '';

    lines.push(`#### ${display.emoji} ${numberPrefix}${finding.title}`);
    lines.push(
      `**Reported Location:** ${location}${finding.category ? ` • **Category:** ${finding.category}` : ''}`
    );
    lines.push(severityLine(severity));
    lines.push('');

    // Message
    lines.push(finding.message);
    lines.push('');

    // Evidence (if present) - put behind "View reasoning" collapsible
    if (finding.evidence) {
      const confidence = Math.round(finding.evidence.confidence * 100);

      if (finding.evidence.reasoning) {
        lines.push(`<details><summary>View reasoning</summary>`);
        lines.push('');
        lines.push(
          `**Evidence:** ${finding.evidence.badge} (${confidence}% confidence)`
        );
        lines.push('');
        lines.push(finding.evidence.reasoning);
        lines.push('</details>');
      } else {
        // No reasoning, show evidence inline
        lines.push(
          `**Evidence:** ${finding.evidence.badge} (${confidence}% confidence)`
        );
      }
      lines.push('');
    }

    const attribution = this.modelAttributionFooter(finding);
    if (attribution) {
      lines.push(attribution);
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatThreadLifecycle(review: Review): string {
    const lifecycle = review.threadLifecycle;
    if (!lifecycle || lifecycle.mode === 'off') return '';

    const stillValidRecords = lifecycle.previousStillValid.filter(
      (record) => !isLinkedCurrentFinding(record)
    );
    const attentionRecords = [
      ...lifecycle.previousUncertain,
      ...lifecycle.manualAttention,
      ...lifecycle.mutationSkipped,
      ...lifecycle.mutationFailed,
      ...lifecycle.skipped.filter(
        (record) =>
          !record.reasonCodes.every((reason) => reason === 'command_dismissed')
      ),
    ];
    const hasStillValid = stillValidRecords.length > 0;
    const hasResolved = lifecycle.resolvedByLifecycle.length > 0;
    const hasAttention =
      attentionRecords.length > 0 ||
      lifecycle.inventoryFailed ||
      lifecycle.warnings.length > 0;

    if (!hasStillValid && !hasResolved && !hasAttention) return '';

    const lines: string[] = [];
    lines.push('## Previous Review Threads');
    lines.push('');

    if (hasStillValid) {
      lines.push('These unresolved findings still look valid and count as active:');
      lines.push('');
      stillValidRecords.forEach((record) => {
        lines.push(this.formatLifecycleRecord(record));
      });
      lines.push('');
    }

    if (hasResolved) {
      lines.push('Resolved by this run:');
      lines.push('');
      lifecycle.resolvedByLifecycle.forEach((record) => {
        lines.push(this.formatLifecycleRecord(record));
      });
      lines.push('');
    }

    if (hasAttention) {
      lines.push('<details>');
      lines.push('<summary>Lifecycle attention required</summary>');
      lines.push('');
      if (lifecycle.inventoryFailed) {
        lines.push('- Review thread inventory failed; no thread was auto-resolved.');
      }
      lifecycle.warnings.forEach((warning) => {
        lines.push(`- ${warning}`);
      });
      attentionRecords.forEach((record) => {
        lines.push(this.formatLifecycleRecord(record));
      });
      lines.push('');
      lines.push('</details>');
    }

    return lines.join('\n');
  }

  private formatLifecycleRecord(record: LifecycleThreadRecord): string {
    const target = record.target;
    const location = `${target.currentPath || target.originalPath}:${target.currentLine ?? target.originalLine ?? '?'}`;
    const severity =
      target.severity === 'critical' ||
      target.severity === 'major' ||
      target.severity === 'minor'
        ? getSeverityDisplay(target.severity).label
        : 'Unknown';
    const reasons = record.reasonCodes
      .map((reason) => this.formatLifecycleReason(reason))
      .join(', ');
    const link = target.threadUrl ? ` - [thread](${target.threadUrl})` : '';

    return `- **${severity}** \`${location}\` - ${target.title}${reasons ? ` (${reasons})` : ''}${link}`;
  }

  private formatLifecycleReason(reason: string): string {
    const labels: Record<string, string> = {
      already_resolved: 'already resolved on GitHub',
      command_dismissed: 'dismissed by /rr skip',
      current_finding_present: 'same finding reported in this run',
      dry_run: 'dry run',
      head_sha_changed: 'PR head changed before mutation',
      human_reply: 'human reply in thread',
      insufficient_resolved_quorum: 'resolved quorum not reached',
      inventory_failed: 'inventory failed',
      invalid_resolved_evidence: 'resolved evidence was insufficient',
      mutation_failed: 'GitHub mutation failed',
      mutation_permission_denied: 'missing permission to resolve',
      mutation_rate_limited: 'GitHub rate limited mutation',
      outside_review_scope: 'outside reviewed diff scope',
      pagination_incomplete: 'thread comments were truncated',
      provider_failed: 'provider failed',
      provider_current_finding_present: 'provider reported same finding in this run',
      provider_missing_revalidation: 'provider omitted revalidation',
      provider_uncertain: 'provider was uncertain',
      report_mode: 'report mode',
      still_valid_vote: 'provider said still valid',
      target_cap_exceeded: 'target cap exceeded',
      thread_changed_before_mutation: 'thread changed before mutation',
      thread_not_found: 'thread no longer found',
      untrusted_author: 'untrusted author',
      viewer_cannot_resolve: 'viewer cannot resolve thread',
    };
    return labels[reason] || reason.replace(/_/g, ' ');
  }

  private countFindingLocations(findings: Finding[]): number {
    return new Set(findings.map((f) => `${f.file}:${f.line}`)).size;
  }

  private modelAttributionFooter(finding: Finding): string | null {
    const attributions = this.normalizeProviderModels(finding);
    if (attributions.length === 0) {
      return null;
    }

    if (attributions.length === 1) {
      return `<sub>Model: ${this.formatProviderModel(attributions[0])}</sub>`;
    }

    const total = Math.max(
      finding.providerPoolSize ?? attributions.length,
      attributions.length
    );
    return `<sub>Models: ${attributions.map((item) => this.formatProviderModel(item)).join(', ')} · agreement ${attributions.length}/${total}</sub>`;
  }

  private normalizeProviderModels(
    finding: Finding
  ): Array<{ provider: string; actualModel?: string }> {
    const merged = new Map<
      string,
      { provider: string; actualModel?: string }
    >();
    for (const item of finding.providerModels || []) {
      merged.set(item.provider, item);
    }
    for (const provider of finding.providers || []) {
      if (!merged.has(provider)) {
        merged.set(provider, { provider });
      }
    }
    if (finding.provider && !merged.has(finding.provider)) {
      merged.set(finding.provider, {
        provider: finding.provider,
        actualModel: finding.actualModel,
      });
    }
    return Array.from(merged.values());
  }

  private formatProviderModel(input: {
    provider: string;
    actualModel?: string;
  }): string {
    return input.provider;
  }

  private formatMetrics(review: Review): string {
    const lines: string[] = [];
    const { metrics, runDetails } = review;
    const hideApiBilling = this.shouldHideApiBilling(review);

    lines.push('<details>');
    lines.push('<summary>Performance Metrics</summary>');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Duration | ${metrics.durationSeconds.toFixed(2)}s |`);
    if (hideApiBilling) {
      lines.push('| Billing | OAuth subscription |');
      if (metrics.totalTokens > 0) {
        lines.push(`| Tokens | ${metrics.totalTokens.toLocaleString()} |`);
      }
    } else if (!this.hasMeasuredApiBilling(review)) {
      lines.push('| Billing | Not reported |');
    } else {
      lines.push(`| Cost | $${metrics.totalCost.toFixed(4)} |`);
      lines.push(`| Tokens | ${metrics.totalTokens.toLocaleString()} |`);
    }
    lines.push(
      `| Providers | ${metrics.providersSuccess}/${metrics.providersUsed} |`
    );
    if (this.hasDismissedFindings(review)) {
      lines.push(`| Overrides | ${metrics.dismissedFindings} dismissed |`);
    }
    if (review.threadLifecycle && review.threadLifecycle.mode !== 'off') {
      const lifecycle = review.threadLifecycle;
      lines.push(
        `| Review thread lifecycle | ${lifecycle.mode}, ${lifecycle.quorumMode} |`
      );
      if (lifecycle.resolvedByLifecycle.length > 0) {
        lines.push(
          `| Previous threads resolved | ${lifecycle.resolvedByLifecycle.length} |`
        );
      }
      const previousStillValidCount = lifecycle.previousStillValid.filter(
        (record) => !isLinkedCurrentFinding(record)
      ).length;
      if (previousStillValidCount > 0) {
        lines.push(
          `| Previous findings still valid | ${previousStillValidCount} |`
        );
      }
    }

    if (runDetails?.cacheHit) {
      lines.push(`| Cache | Hit |`);
    }

    lines.push('');

    // Provider details
    if (runDetails?.providers && runDetails.providers.length > 0) {
      lines.push('**Provider Performance:**');
      lines.push('');

      runDetails.providers.forEach((p) => {
        const statusEmoji =
          p.status === 'success'
            ? '✅'
            : p.status === 'timeout'
              ? '⏱️'
              : p.status === 'rate-limited'
                ? '⏸️'
                : '❌';

        const costStr =
          !hideApiBilling && p.cost !== undefined
            ? `, $${p.cost.toFixed(4)}`
            : '';
        const tokensStr = p.tokens ? `, ${p.tokens} tokens` : '';

        lines.push(
          `- ${statusEmoji} **${p.name}** (${p.durationSeconds.toFixed(2)}s${costStr}${tokensStr})`
        );

        if (p.errorMessage) {
          lines.push(`  <sub>${p.errorMessage}</sub>`);
        }
      });

      lines.push('');
    }

    lines.push('</details>');

    return lines.join('\n');
  }

  private shouldHideApiBilling(review: Review): boolean {
    const hasOAuthCliUsage = (review.runDetails?.providers || []).some((p) =>
      /^(codex|claude|gemini|opencode)\//.test(p.name)
    );

    return review.metrics.totalCost === 0 && hasOAuthCliUsage;
  }

  private hasMeasuredApiBilling(review: Review): boolean {
    return review.metrics.totalCost > 0 || review.metrics.totalTokens > 0;
  }

  private hasDismissedFindings(review: Review): boolean {
    return (review.metrics.dismissedFindings ?? 0) > 0;
  }

  private hasScopeLimitations(review: Review): boolean {
    const coverage = review.coverage;
    if (!coverage) return false;
    return (
      coverage.compactedFiles > 0 ||
      coverage.metadataOnlyFiles > 0 ||
      coverage.skippedFiles > 0
    );
  }

  private didAllProviderRunsFail(review: Review): boolean {
    return (
      review.metrics.providersUsed > 0 &&
      review.metrics.providersSuccess === 0 &&
      review.metrics.providersFailed > 0
    );
  }

  private formatAdvancedSections(review: Review): string {
    const lines: string[] = [];

    // AI Analysis
    if (review.aiAnalysis) {
      lines.push('<details>');
      lines.push('<summary>AI-Generated Code Analysis</summary>');
      lines.push('');
      lines.push(
        `**Overall Likelihood:** ${(review.aiAnalysis.averageLikelihood * 100).toFixed(1)}%`
      );
      lines.push('');
      lines.push(`**Consensus:** ${review.aiAnalysis.consensus}`);
      lines.push('');

      if (Object.keys(review.aiAnalysis.providerEstimates).length > 0) {
        lines.push('**Provider Estimates:**');
        Object.entries(review.aiAnalysis.providerEstimates).forEach(
          ([provider, likelihood]) => {
            lines.push(`- ${provider}: ${(likelihood * 100).toFixed(1)}%`);
          }
        );
        lines.push('');
      }

      lines.push('</details>');
      lines.push('');
    }

    // Impact Graph
    if (this.shouldShowImpactGraph(review.mermaidDiagram)) {
      lines.push('<details>');
      lines.push('<summary>Impact Analysis Graph</summary>');
      lines.push('');
      lines.push('```mermaid');
      lines.push(review.mermaidDiagram!);
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }

    return lines.join('\n');
  }

  private shouldShowImpactGraph(mermaidDiagram?: string): boolean {
    if (!mermaidDiagram?.trim()) return false;

    // A graph with only standalone nodes adds noise in PR comments.
    return /(?:-->|---|-.->|==>)/.test(mermaidDiagram);
  }

  private formatFooter(review: Review): string {
    return `<sub>${this.formatRunSummary(review)} • Powered by ReviewRouter</sub>`;
  }
}
