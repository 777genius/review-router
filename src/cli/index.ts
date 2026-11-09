#!/usr/bin/env node

import { GitReader } from './git-reader';
import { TerminalFormatter } from './formatter';
import { CLIReviewer } from './reviewer';
import { setupComponents } from '../setup';
import { PRContext } from '../types';
import { logger } from '../utils/logger';
import { generateAnalytics, printSummary } from './analytics';
import { parseLocalReviewOptions, usesExplicitLocalOptions } from '../local-review/cli-options';
import { LocalReviewUsageError, LocalReviewExecutionError, LocalReviewInterruptedError, exitCodeForLocalOutcome, renderLocalReview } from '../local-review/contracts';
import { runLocalReview } from '../local-review/run-local-review';
import { NativeOcrEngine } from '../local-review/native-ocr';
import { ConfigLoader } from '../config/loader';

/**
 * CLI interface for multi-provider code review
 */
export class CLI {
  private gitReader: GitReader;
  private formatter: TerminalFormatter;

  constructor() {
    this.gitReader = new GitReader();
    this.formatter = new TerminalFormatter();
  }

  /**
   * Main CLI entry point
   */
  async run(args: string[]): Promise<number> {
    try {
      // Parse command and arguments
      const { command, target, options } = this.parseArgs(args);

      // Global informational commands must work outside a Git checkout.
      if (command === 'help' || command === '--help' || command === '-h') {
        this.showHelp();
        return 0;
      }
      if (command === 'version' || command === '--version' || command === '-v') {
        this.showVersion();
        return 0;
      }
      if (command === 'doctor') {
        return this.runDoctor();
      }
      if (command === 'review' && args.slice(1).includes('--help')) {
        this.showHelp();
        return 0;
      }
      if (command === 'review' && usesExplicitLocalOptions(args.slice(1))) {
        return this.runExplicitLocalReview(args.slice(1));
      }

      // Existing positional CLI remains unchanged unless new flags are explicitly selected.
      if (!this.gitReader.isGitRepo()) {
        console.error(
          this.formatter.formatMessage('Not in a git repository', 'error')
        );
        return 1;
      }

      // Handle commands
      switch (command) {
        case 'review':
          return await this.runReview(target, options);

        case 'analytics':
          return await this.runAnalytics(target, options);

        case 'help':
        case '--help':
        case '-h':
          this.showHelp();
          return 0;

        case 'version':
        case '--version':
        case '-v':
          this.showVersion();
          return 0;

        default:
          console.error(
            this.formatter.formatMessage(`Unknown command: ${command}`, 'error')
          );
          this.showHelp();
          return 1;
      }
    } catch (error) {
      console.error(this.formatter.formatMessage(String(error), 'error'));
      return 1;
    }
  }

  /** Explicit local execution contract. Engine-specific IO stays in adapters. */
  private async runExplicitLocalReview(args: string[]): Promise<number> {
    const wantsJson = args.some((arg, i) => arg === '--format=json' || (arg === '--format' && args[i + 1] === 'json'));
    try {
      const parsed = parseLocalReviewOptions(args);
      if (parsed.request.engine === 'legacy' && parsed.format === 'json') {
        throw new LocalReviewUsageError(
          'Legacy JSON is not yet qualified; use --engine ocr --format json or the existing legacy terminal output.'
        );
      }
      const cancellation = new AbortController();
      const onInterrupt = (): void => cancellation.abort();
      // The legacy engine has no cancellation port: do not swallow its normal
      // terminal signals by installing a handler it cannot observe.
      const cancellable = parsed.request.engine === 'ocr';
      if (cancellable) {
        process.once('SIGINT', onInterrupt);
        process.once('SIGTERM', onInterrupt);
      }
      const result = await (async () => {
        try {
          return await runLocalReview(
            { ...parsed.request, ...(cancellable ? { signal: cancellation.signal } : {}) },
            { configFile: parsed.configFile }
          );
        } finally {
          if (cancellable) {
            process.removeListener('SIGINT', onInterrupt);
            process.removeListener('SIGTERM', onInterrupt);
          }
        }
      })();
      if (parsed.format === 'json') process.stdout.write(JSON.stringify(result) + '\n');
      else console.log(renderLocalReview(result));
      return exitCodeForLocalOutcome(result);
    } catch (error) {
      const usage = error instanceof LocalReviewUsageError;
      const interrupted = error instanceof LocalReviewInterruptedError;
      const message = usage || interrupted || error instanceof LocalReviewExecutionError
        ? error.message : 'Local review failed; no clean result was established.';
      if (wantsJson) {
        process.stdout.write(JSON.stringify({ schemaVersion: 1, status: 'failed', error: {
          kind: interrupted ? 'interrupted' : usage ? 'usage' : 'execution', message
        } }) + '\n');
      } else {
        console.error(this.formatter.formatMessage(message, 'error'));
      }
      return interrupted ? 130 : usage ? 4 : 3;
    }
  }

  private async runDoctor(): Promise<number> {
    console.log('ReviewRouter local engines: legacy (built-in)');
    try {
      const version = await new NativeOcrEngine().doctor(process.cwd());
      console.log('Native OCR: ' + version + ' (installed; authentication not probed)');
      return 0;
    } catch {
      console.log('Native OCR: unavailable or incompatible (requires pinned v1.13.1)');
      console.log('Set REVIEWROUTER_OCR_BINARY to an absolute trusted binary path, or install a compatible OCR.');
      return 4;
    }
  }

  /**
   * Run code review
   */
  private async runReview(
    target?: string,
    options: Record<string, unknown> = {}
  ): Promise<number> {
    let components: any = null;

    try {
      console.log(
        this.formatter.formatMessage('Starting code review...', 'info')
      );
      console.log('');

      // Get changes based on target
      let pr: PRContext;

      if (!target) {
        // No target: review uncommitted changes
        pr = await this.gitReader.getUncommittedChanges();
        console.log(
          this.formatter.formatMessage('Reviewing uncommitted changes', 'info')
        );
      } else if (target.includes('..')) {
        // Range: review between commits/branches
        const [base, head] = target.split('..');
        pr = await this.gitReader.getBranchChanges(base, head);
        console.log(
          this.formatter.formatMessage(
            `Reviewing changes from ${base} to ${head || 'HEAD'}`,
            'info'
          )
        );
      } else {
        // Single commit
        pr = await this.gitReader.getCommitChanges(target);
        console.log(
          this.formatter.formatMessage(`Reviewing commit ${target}`, 'info')
        );
      }

      // Check if there are changes
      if (pr.files.length === 0) {
        console.log(
          this.formatter.formatMessage('No changes to review', 'success')
        );
        return 0;
      }

      console.log(
        this.formatter.formatMessage(
          `Found ${pr.files.length} changed file(s)`,
          'info'
        )
      );
      console.log('');

      // Setup components (CLI mode)
      components = await setupComponents({
        cliMode: true,
        dryRun: options['dry-run'] === true,
        ...(typeof options.config === 'string' ? { config: ConfigLoader.loadFromPath(options.config) } : {}),
      });

      // Create CLI reviewer
      const reviewer = new CLIReviewer(components);

      // Run review
      const review = await reviewer.review(pr);

      // Format and display results
      const output = this.formatter.format(review);
      console.log(output);

      // Return exit code based on severity
      return this.formatter.getExitCode(review);
    } catch (error) {
      logger.error('Review failed', { error: String(error) });
      throw error;
    } finally {
      // Clean up resources to prevent memory leaks
      if (components?.costTracker) {
        components.costTracker.reset();
      }
    }
  }

  /**
   * Run analytics command
   */
  private async runAnalytics(
    subcommand?: string,
    options: Record<string, unknown> = {}
  ): Promise<number> {
    try {
      if (subcommand === 'summary' || !subcommand) {
        // Show summary
        const days = Number(options.days ?? 30);
        if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new LocalReviewUsageError('--days must be 1..3650.');
        await printSummary(days);
        return 0;
      } else if (subcommand === 'generate') {
        // Generate dashboard
        await generateAnalytics({
          output: (options.output as string) || './reports',
          format: (options.format as 'html' | 'csv' | 'json') || 'html',
          days: Number(options.days ?? 30),
        });
        return 0;
      } else {
        console.error(
          this.formatter.formatMessage(
            `Unknown analytics subcommand: ${subcommand}`,
            'error'
          )
        );
        this.showAnalyticsHelp();
        return 1;
      }
    } catch (error) {
      logger.error('Analytics command failed', error as Error);
      return 1;
    }
  }

  /**
   * Show analytics help
   */
  private showAnalyticsHelp(): void {
    const help = `
Analytics Commands:

Usage:
  mpr analytics summary [--days=N]           Show summary statistics
  mpr analytics generate [options]           Generate analytics dashboard

Options:
  --output=<dir>                             Output directory (default: ./reports)
  --format=<html|csv|json>                   Output format (default: html)
  --days=<number>                            Days of data to include (default: 30)

Examples:
  mpr analytics summary                      Show last 30 days summary
  mpr analytics summary --days=7             Show last 7 days summary
  mpr analytics generate                     Generate HTML dashboard
  mpr analytics generate --format=csv        Generate CSV export
`;
    console.log(help);
  }

  /**
   * Parse command line arguments
   */
  private parseArgs(args: string[]): {
    command: string;
    target?: string;
    options: Record<string, unknown>;
  } {
    const command = args[0] || 'help';
    let target: string | undefined;
    const options: Record<string, unknown> = {};

    // Parse target and options
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];

      if (arg.startsWith('--')) {
        // Long option
        const [key, value] = arg.substring(2).split('=');
        options[key] = value || true;
      } else if (arg.startsWith('-')) {
        // Short option
        const key = arg.substring(1);
        options[key] = true;
      } else {
        // Target (commit, branch, range)
        target = arg;
      }
    }

    return { command, target, options };
  }

  /**
   * Show help message
   */
  private showHelp(): void {
    const help = `
ReviewRouter CLI

Usage:
  review-router review [target] [options]
                                   Run code review
  review-router analytics <command> [options]
                                   Manage analytics and dashboards
  review-router help               Show this help
  review-router doctor             Check local engines (no model call)
  review-router version            Show version

Review Targets:
  (none)                          Review uncommitted changes
  HEAD~1                          Review specific commit
  main..feature                   Review branch changes
  abc123..def456                  Review commit range

Review Options:
  --dry-run                       No GitHub publication (still calls the model)
  --engine=ocr                    Use native OCR (opt-in)
  --scope=branch --base=origin/main  Review branch since merge-base
  --scope=commit --ref=HEAD       Review one commit
  --include-untracked             Consent to native OCR reading new files
  --format=json                   OCR structured output for coding agents

Analytics Commands:
  summary [--days=N]              Show summary statistics
  generate [options]              Generate analytics dashboard

Examples:
  review-router review            Review uncommitted changes
  review-router review HEAD~1     Review last commit
  review-router review main..feature
                                   Review feature branch
  review-router analytics summary Show analytics summary
  review-router analytics generate
                                   Generate HTML dashboard

Exit Codes:
  0    No issues or only minor issues
  1    Major issues found
  2    Critical issues found
`;

    console.log(help);
  }

  /**
   * Show version
   */
  private showVersion(): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const pkg = require('../../package.json');
    console.log(`review-router v${pkg.version}`);
  }
}

/**
 * Main entry point when run from command line
 */
if (require.main === module) {
  const cli = new CLI();
  const args = process.argv.slice(2);

  cli
    .run(args)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exitCode = 1;
    });
}
