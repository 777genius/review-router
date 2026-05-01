import { createHmac, timingSafeEqual } from 'crypto';
import { Severity } from '../types';
import { logger } from '../utils/logger';
import { GitHubClient } from './client';

const LEDGER_MARKER = 'reviewrouter-ledger:v1';
const LEDGER_RE =
  /<!--\s*reviewrouter-ledger:v1\s+payload=([A-Za-z0-9_-]+)\s+signature=([a-f0-9]{64})\s*-->/;
const MAX_LEDGER_ENTRIES = 200;

export type LedgerAction = 'skip' | 'unskip';

export interface LedgerEntry {
  action: LedgerAction;
  fingerprint: string;
  legacyFingerprint?: string;
  severity: Severity;
  path?: string;
  line?: number | null;
  title?: string;
  reason?: string;
  actor: string;
  actorRole: string;
  headSha?: string;
  parentCommentId: number;
  commandCommentId?: number;
  createdAt: string;
}

export interface ReviewLedgerPayload {
  version: 1;
  repo: string;
  pr: number;
  entries: LedgerEntry[];
}

export interface LoadedLedger {
  valid: boolean;
  payload: ReviewLedgerPayload;
  commentId?: number;
  invalidReason?: string;
}

interface LedgerComment {
  id: number;
  body: string;
}

export interface ActiveLedgerSkip extends LedgerEntry {
  action: 'skip';
}

export class ReviewLedger {
  constructor(
    private readonly client: GitHubClient,
    private readonly secret: string | undefined,
    private readonly dryRun = false
  ) {}

  async load(prNumber: number): Promise<LoadedLedger> {
    const empty = this.emptyPayload(prNumber);
    if (!this.secret) {
      return {
        valid: false,
        payload: empty,
        invalidReason: 'REVIEW_ROUTER_LEDGER_KEY is not configured',
      };
    }

    const comments = await this.findLedgerComments(prNumber);
    if (comments.length === 0) {
      return { valid: true, payload: empty };
    }

    const invalidReasons: string[] = [];
    for (const comment of comments) {
      const parsed = this.parse(comment.body);
      if (!parsed) {
        invalidReasons.push('ledger marker is malformed');
        continue;
      }

      const expected = this.sign(parsed.payload);
      if (!safeEqualHex(expected, parsed.signature)) {
        invalidReasons.push('ledger signature is invalid');
        continue;
      }

      if (
        parsed.payload.repo !== `${this.client.owner}/${this.client.repo}` ||
        parsed.payload.pr !== prNumber
      ) {
        invalidReasons.push(
          'ledger belongs to a different repository or pull request'
        );
        continue;
      }

      return {
        valid: true,
        payload: {
          ...parsed.payload,
          entries: parsed.payload.entries.slice(-MAX_LEDGER_ENTRIES),
        },
        commentId: comment.id,
      };
    }

    return {
      valid: false,
      payload: empty,
      invalidReason:
        invalidReasons[0] || 'no valid signed ledger comment found',
    };
  }

  async append(prNumber: number, entry: LedgerEntry): Promise<LoadedLedger> {
    if (!this.secret) {
      throw new Error(
        'REVIEW_ROUTER_LEDGER_KEY is required to update the override ledger'
      );
    }
    const loaded = await this.load(prNumber);
    const payload = loaded.valid ? loaded.payload : this.emptyPayload(prNumber);
    payload.entries = [...payload.entries, entry].slice(-MAX_LEDGER_ENTRIES);
    await this.save(payload, loaded.commentId);
    return { valid: true, payload, commentId: loaded.commentId };
  }

  activeSkips(
    payload: ReviewLedgerPayload,
    headSha?: string
  ): ActiveLedgerSkip[] {
    const byFingerprint = new Map<string, LedgerEntry>();
    for (const entry of payload.entries) {
      const key = entry.fingerprint;
      if (!key) continue;
      byFingerprint.set(key, entry);
      if (entry.legacyFingerprint) {
        byFingerprint.set(entry.legacyFingerprint, entry);
      }
    }

    const active: ActiveLedgerSkip[] = [];
    const seen = new Set<string>();
    for (const entry of byFingerprint.values()) {
      if (entry.action !== 'skip') continue;
      if (
        headSha &&
        entry.headSha &&
        entry.headSha !== headSha &&
        process.env.REVIEW_ROUTER_KEEP_SKIPS_ACROSS_PUSHES !== 'true'
      ) {
        continue;
      }
      if (seen.has(entry.fingerprint)) continue;
      seen.add(entry.fingerprint);
      active.push(entry as ActiveLedgerSkip);
    }
    return active;
  }

  statusText(payload: ReviewLedgerPayload, headSha?: string): string {
    const active = this.activeSkips(payload, headSha);
    if (active.length === 0) {
      return 'No active skipped findings.';
    }

    return active
      .map((entry) => {
        const location = entry.path
          ? `${entry.path}${entry.line ? `:${entry.line}` : ''}`
          : 'unknown location';
        const reason = entry.reason ? ` - ${entry.reason}` : '';
        return `- ${entry.severity} ${location} by @${entry.actor}${reason}`;
      })
      .join('\n');
  }

  private async save(
    payload: ReviewLedgerPayload,
    commentId?: number
  ): Promise<void> {
    const body = this.render(payload);
    if (this.dryRun) {
      logger.info(
        `[DRY RUN] Would update ReviewRouter ledger comment for PR #${payload.pr}`
      );
      return;
    }

    const { octokit, owner, repo } = this.client;
    if (commentId) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
      return;
    }

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: payload.pr,
      body,
    });
  }

  private async findLedgerComments(prNumber: number): Promise<LedgerComment[]> {
    const { octokit, owner, repo } = this.client;
    const comments = (await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    })) as Array<{ id?: number; body?: string | null }>;

    return comments
      .filter(
        (comment): comment is LedgerComment =>
          typeof comment.id === 'number' &&
          typeof comment.body === 'string' &&
          comment.body.includes(LEDGER_MARKER)
      )
      .map((comment) => ({ id: comment.id, body: comment.body }));
  }

  private parse(
    body: string
  ): { payload: ReviewLedgerPayload; signature: string } | null {
    const match = body.match(LEDGER_RE);
    if (!match) return null;

    try {
      const payload = JSON.parse(
        Buffer.from(match[1], 'base64url').toString('utf8')
      ) as ReviewLedgerPayload;
      if (payload.version !== 1 || !Array.isArray(payload.entries)) {
        return null;
      }
      return { payload, signature: match[2] };
    } catch {
      return null;
    }
  }

  private render(payload: ReviewLedgerPayload): string {
    const payloadText = canonicalJson(payload);
    const encoded = Buffer.from(payloadText, 'utf8').toString('base64url');
    const signature = this.sign(payload);
    const status = this.statusText(payload);

    return [
      `<!-- ${LEDGER_MARKER}`,
      `payload=${encoded}`,
      `signature=${signature}`,
      '-->',
      '',
      '<sub>ReviewRouter override state - signed `/rr skip` records for reruns. Do not edit.</sub>',
      '',
      '<details>',
      '<summary>Active skips</summary>',
      '',
      status,
      '',
      '</details>',
    ].join('\n');
  }

  private sign(payload: ReviewLedgerPayload): string {
    return createHmac('sha256', this.secret || '')
      .update(canonicalJson(payload))
      .digest('hex');
  }

  private emptyPayload(prNumber: number): ReviewLedgerPayload {
    return {
      version: 1,
      repo: `${this.client.owner}/${this.client.repo}`,
      pr: prNumber,
      entries: [],
    };
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) {
    return false;
  }
  const aBuffer = Buffer.from(a, 'hex');
  const bBuffer = Buffer.from(b, 'hex');
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}
