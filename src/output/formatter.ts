import { Review } from '../types';
import { severityLine } from '../utils/severity';

export class MarkdownFormatter {
  format(review: Review): string {
    const lines: string[] = [];
    lines.push('## AI Robot Review Summary');
    lines.push('');
    lines.push(review.summary);

    const critical = review.findings.filter((f) => f.severity === 'critical');
    const major = review.findings.filter((f) => f.severity === 'major');
    const minor = review.findings.filter((f) => f.severity === 'minor');

    this.printSeveritySection(lines, 'Critical', critical);
    this.printSeveritySection(lines, 'Major', major);
    this.printSeveritySection(lines, 'Minor', minor);

    lines.push('\n---');
    lines.push(
      '<details><summary>Run details (usage, cost, providers, status)</summary>'
    );
    lines.push('');
    const hideApiBilling = this.shouldHideApiBilling(review);
    const detailParts = [
      `Duration: ${review.metrics.durationSeconds.toFixed(1)}s`,
    ];
    if (hideApiBilling) {
      detailParts.push('OAuth subscription');
      if (review.metrics.totalTokens > 0) {
        detailParts.push(`Tokens: ${review.metrics.totalTokens}`);
      }
    } else if (this.hasMeasuredApiBilling(review)) {
      detailParts.push(`Cost: $${review.metrics.totalCost.toFixed(4)}`);
      detailParts.push(`Tokens: ${review.metrics.totalTokens}`);
    } else {
      detailParts.push('Billing: not reported');
    }
    lines.push(`- ${detailParts.join(' • ')}`);
    lines.push(
      `- Providers used: ${review.metrics.providersUsed} (success ${review.metrics.providersSuccess}, failed ${review.metrics.providersFailed})`
    );
    if (review.runDetails) {
      review.runDetails.providers.forEach((p) => {
        const costStr =
          !hideApiBilling && p.cost !== undefined
            ? `, $${p.cost.toFixed(4)}`
            : '';
        lines.push(
          `  - ${p.name}: ${p.status} (${p.durationSeconds.toFixed(1)}s${costStr}${p.tokens ? `, tokens ${p.tokens}` : ''}${p.errorMessage ? `, error: ${p.errorMessage}` : ''})`
        );
      });

      const timeouts = review.runDetails.providers.filter((p) =>
        p.errorMessage?.includes('timed out')
      );
      if (timeouts.length > 0) {
        lines.push('');
        lines.push(
          `*Note: ${timeouts.length} provider(s) timed out. This is expected for large PRs and does not affect the quality of results from successful providers.*`
        );
      }
    }
    lines.push('</details>');

    if (review.aiAnalysis) {
      lines.push('\n<details><summary>AI Generated Code Likelihood</summary>');
      lines.push('');
      lines.push(
        `- Overall: ${(review.aiAnalysis.averageLikelihood * 100).toFixed(1)}% (${review.aiAnalysis.consensus})`
      );
      lines.push('</details>');
    }

    if (review.mermaidDiagram && review.mermaidDiagram.trim()) {
      lines.push('\n<details><summary>Impact graph</summary>');
      lines.push('');
      lines.push('```mermaid');
      lines.push(review.mermaidDiagram);
      lines.push('```');
      lines.push('</details>');
    }

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

  private printSeveritySection(
    lines: string[],
    title: string,
    findings: Review['findings']
  ): void {
    if (findings.length === 0) return;
    lines.push(`\n### ${title}`);
    findings.forEach((f) => {
      lines.push(`- ${f.file}:${f.line} - ${f.title}`);
      lines.push(`  ${severityLine(f.severity)}`);
      lines.push(`  ${f.message}`);
      if (f.evidence) {
        lines.push(
          `  Evidence: ${f.evidence.badge} (${Math.round(f.evidence.confidence * 100)}%)${f.evidence.reasoning ? ` - ${f.evidence.reasoning}` : ''}`
        );
      }
    });
  }
}
