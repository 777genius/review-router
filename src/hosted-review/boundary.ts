/** Shared policy for the credential-bearing hosted API transports. */
export function hostedV4ApiOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('hosted_v4_api_url_invalid');
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  const mappedFirstByte = mapped ? parseInt(mapped[1], 16) >> 8 : -1;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'localhost.localdomain' ||
    host === '::1' ||
    host === '::' ||
    (ipv4 !== null && (Number(ipv4[1]) === 127 || Number(ipv4[1]) === 0)) ||
    mappedFirstByte === 127 ||
    mappedFirstByte === 0
  ) {
    throw new Error('hosted_v4_api_url_invalid');
  }
  return url;
}

const SAFE_CODES = new Set([
  'hosted_v4_adapter_disabled',
  'hosted_v4_verified_t0_handoff_required',
  'hosted_v4_api_url_invalid',
  'hosted_v4_input_invalid',
  'hosted_v4_binding_hints_invalid',
  'hosted_v4_deadline_expired',
  'hosted_v4_oidc_unavailable',
  'hosted_v4_oidc_url_untrusted',
  'hosted_v4_oidc_denied',
  'hosted_v4_oidc_malformed',
  'hosted_v4_oidc_response_too_large',
  'hosted_v4_oidc_transport_ambiguous',
  'hosted_v4_authority_stale_or_unsupported',
  'hosted_v4_authority_expired_or_malformed',
  'hosted_v4_paid_turn_unavailable',
  'hosted_v4_read_authority_denied',
  'hosted_v4_read_capability_expired_or_stale',
  'hosted_v4_read_capability_malformed',
  'hosted_v4_read_capacity_limited',
  'hosted_v4_read_content_drift',
  'hosted_v4_read_expiry_invalid',
  'hosted_v4_read_head_or_path_drift',
  'hosted_v4_read_http_failure',
  'hosted_v4_read_malformed_or_stale',
  'hosted_v4_read_not_admitted',
  'hosted_v4_read_origin_drift',
  'hosted_v4_read_path_invalid',
  'hosted_v4_read_request_too_large',
  'hosted_v4_read_response_malformed',
  'hosted_v4_read_response_too_large',
  'hosted_v4_read_route_unavailable',
  'hosted_v4_read_scope_expired',
  'hosted_v4_read_transient_unavailable',
  'hosted_v4_read_transport_ambiguous',
  'review_action_v2_authorization_denied',
]);

/** Exact complete codes only. No untrusted error text crosses the Action boundary. */
export function hostedV4SafeErrorCode(error: unknown): string {
  return error instanceof Error && SAFE_CODES.has(error.message)
    ? error.message
    : 'hosted_v4_failed_closed';
}

export class HostedV4Deadline {
  constructor(
    private readonly deadlineEpochMs: number,
    private readonly now: () => number
  ) {}

  assertLive(expiry?: string): void {
    if (this.remaining(expiry) <= 0)
      throw new Error('hosted_v4_deadline_expired');
  }

  remaining(expiry?: string): number {
    const expiryTime =
      expiry === undefined ? this.deadlineEpochMs : Date.parse(expiry);
    if (!Number.isFinite(expiryTime)) return 0;
    const end = Math.min(this.deadlineEpochMs, expiryTime);
    return Math.max(0, Math.ceil(end - this.now()));
  }

  async run<T>(
    work: (signal: AbortSignal, remainingMs: number) => Promise<T>,
    expiry?: string
  ): Promise<T> {
    this.assertLive(expiry);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('hosted_v4_deadline_expired'));
      }, this.remaining(expiry));
    });
    try {
      const value = await Promise.race([
        work(controller.signal, this.remaining(expiry)),
        timeout,
      ]);
      this.assertLive(expiry);
      return value;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
}
