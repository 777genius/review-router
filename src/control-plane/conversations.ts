import { createHash } from 'crypto';
import type { RuntimeConfigResult } from './runtime-config';
import { postBoundedMemoryJson } from './review-memory-v2';

export type ConversationSource = Readonly<{
  protocolVersion: 2;
  pullRequestNumber: number;
  sourceCommentId: string;
  sourceRevision: string;
  eventAction: 'created' | 'edited' | 'deleted';
}>;

export type ConversationResult = Readonly<{
  protocolVersion: 2;
  processingId: string;
  status:
    | 'processing'
    | 'ready'
    | 'silent'
    | 'published'
    | 'context_incomplete'
    | 'stale'
    | 'unavailable'
    | 'output_unavailable'
    | 'unknown';
  learning: Readonly<{ status: string; effectIds: readonly string[] }>;
  reply?: Readonly<{
    body: string;
    bodyDigest: string;
    marker: string;
    parentCommentId: string;
  }>;
  publicationCommentId?: string;
}>;

export type ConversationPublication = Readonly<{
  protocolVersion: 2;
  processingId: string;
  status: 'published' | 'unknown' | 'failed';
  commentId?: string;
  bodyDigest?: string;
}>;

/** Source references only. Source, account, learning and reply policy belong to the server. */
export interface ConversationPort {
  process(source: ConversationSource): Promise<ConversationResult>;
  status(processingId: string): Promise<ConversationResult>;
  publication(receipt: ConversationPublication): Promise<void>;
}

export class ControlPlaneConversationClient implements ConversationPort {
  constructor(
    private readonly runtime: Extract<
      RuntimeConfigResult,
      { status: 'applied' }
    >,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async process(source: ConversationSource): Promise<ConversationResult> {
    return parseConversationResult(await this.post('process', source, 90_000));
  }

  async status(processingId: string): Promise<ConversationResult> {
    return parseConversationResult(
      await this.post('status', { protocolVersion: 2, processingId }, 10_000)
    );
  }

  async publication(receipt: ConversationPublication): Promise<void> {
    await this.post('publication', receipt, 10_000);
  }

  private post(
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    return postBoundedMemoryJson({
      url: new URL(`/api/action/v2/conversations/${path}`, this.runtime.apiUrl),
      token: this.runtime.sessionToken,
      body,
      timeoutMs,
      maxBytes: 32 * 1024,
      fetchImpl: this.fetchImpl,
    });
  }
}

function parseConversationResult(value: unknown): ConversationResult {
  const invalid = () => new Error('conversation_response_invalid');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  const input = value as Record<string, unknown>;
  const statuses = new Set([
    'processing',
    'ready',
    'silent',
    'published',
    'context_incomplete',
    'stale',
    'unavailable',
    'output_unavailable',
    'unknown',
  ]);
  if (
    input.protocolVersion !== 2 ||
    !boundedId(input.processingId) ||
    typeof input.status !== 'string' ||
    !statuses.has(input.status) ||
    !input.learning ||
    typeof input.learning !== 'object' ||
    Array.isArray(input.learning)
  )
    throw invalid();
  const learning = input.learning as Record<string, unknown>;
  if (
    !boundedId(learning.status) ||
    !Array.isArray(learning.effectIds) ||
    learning.effectIds.length > 16 ||
    !learning.effectIds.every(boundedId)
  )
    throw invalid();
  if (
    input.publicationCommentId !== undefined &&
    !numericId(input.publicationCommentId)
  )
    throw invalid();
  let reply: ConversationResult['reply'];
  if (input.reply !== undefined) {
    if (
      !input.reply ||
      typeof input.reply !== 'object' ||
      Array.isArray(input.reply)
    )
      throw invalid();
    const candidate = input.reply as Record<string, unknown>;
    if (
      typeof candidate.body !== 'string' ||
      !candidate.body.trim() ||
      Buffer.byteLength(candidate.body, 'utf8') > 16 * 1024 ||
      typeof candidate.bodyDigest !== 'string' ||
      createHash('sha256').update(candidate.body, 'utf8').digest('hex') !==
        candidate.bodyDigest ||
      typeof candidate.marker !== 'string' ||
      candidate.marker.length > 512 ||
      !/^<!-- reviewrouter-conversation:v1 [a-zA-Z0-9_=:.-]+ -->$/.test(
        candidate.marker
      ) ||
      candidate.body.split(candidate.marker).length !== 2 ||
      !numericId(candidate.parentCommentId)
    )
      throw invalid();
    reply = Object.freeze(candidate as ConversationResult['reply']);
  }
  if (input.status === 'ready' && !reply) throw invalid();
  return Object.freeze({
    protocolVersion: 2,
    processingId: input.processingId as string,
    status: input.status as ConversationResult['status'],
    learning: Object.freeze({
      status: learning.status as string,
      effectIds: Object.freeze(learning.effectIds as string[]),
    }),
    ...(reply ? { reply } : {}),
    ...(input.publicationCommentId
      ? { publicationCommentId: input.publicationCommentId as string }
      : {}),
  });
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
}
function numericId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}
