import {
  AcceptedRevalidation,
  byteHash,
  ImmutableSourceReader,
  LifecycleInference,
  planFindingRevalidation,
  PlanRevalidationInput,
  prepareLifecycleRequest,
  RevalidationPlanningPorts,
  RevalidationTarget,
  runFindingRevalidation,
  validateLifecycleResponse,
} from '../../../src/finding-revalidation';

const headSha = 'a'.repeat(40);
const blobOid = 'b'.repeat(40);
const source =
  'export function tax(amount: number) {\n  return Math.max(0, amount) * 0.2;\n}\n';
function target(
  index: number,
  extra: Partial<RevalidationTarget> = {}
): RevalidationTarget {
  return {
    targetId: `target-${index}`,
    threadId: `thread-${index}`,
    fingerprint: `fingerprint-${index}`,
    parentId: `parent-${index}`,
    parentCreatedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    parentUpdatedAt: '2026-10-10T00:00:00Z',
    parentBodyHash: 'parent-hash',
    claimHash: 'claim-hash',
    commentStateHash: 'comments-hash',
    ledgerWatermark: 'ledger-1',
    originalPath: 'src/tax.ts',
    currentPath: null,
    originalLine: 2,
    currentLine: 2,
    severity: 'major',
    title: 'Tax computation',
    message: 'Negative amounts must not create negative tax.',
    diffHunk: null,
    isResolved: false,
    trusted: true,
    hasHumanReply: false,
    parentEdited: false,
    markerAmbiguous: false,
    commandDismissed: false,
    ...extra,
  };
}
function input(targets: readonly RevalidationTarget[]): PlanRevalidationInput {
  return {
    scope: {
      workspaceId: 'workspace',
      repositoryConnectionId: 'connection',
      repository: 'owner/repo',
      pullRequestNumber: 1,
      baseSha: 'c'.repeat(40),
      mergeBaseSha: 'd'.repeat(40),
      headSha,
      reviewRevisionHash: 'revision',
    },
    participant: {
      voteIdentityHash: 'identity',
      capabilityDigest: 'capability',
      model: 'saved-model',
    },
    inventoryComplete: true,
    targets,
    limits: {
      gatewayOutputTokens: 4096,
      modelOutputTokens: 4096,
      remainingWorkSlots: 2,
    },
    policyDigest: 'policy',
  };
}
function ports(content = source): RevalidationPlanningPorts {
  const sourceReader: ImmutableSourceReader = {
    read: async ({ headSha, path }) => ({
      kind: 'file',
      headSha,
      path,
      blobOid,
      bytes: Buffer.from(content),
    }),
  };
  return {
    sourceReader,
    priorResolutionHistory: {
      read: async () => ({
        historyCut: 'cut',
        guardVersion: '1',
        state: 'before_cut_unobserved',
      }),
    },
    isPathAllowed: (path) => !path.startsWith('.env'),
  };
}
function result(
  id: number,
  verdict: AcceptedRevalidation['verdict'] = 'resolved'
): AcceptedRevalidation {
  return {
    targetId: `target-${id}`,
    fingerprint: `fingerprint-${id}`,
    verdict,
    confidence: 0.95,
    scopeSufficient: true,
    failureCondition:
      'A negative taxable amount previously yielded negative tax.',
    fixExplanation:
      'The max(0, amount) guard clamps the taxable base before multiplication.',
    evidence: [
      {
        path: 'src/tax.ts',
        blobOid,
        startLine: 2,
        endLine: 2,
        quote: 'return Math.max(0, amount) * 0.2;',
        reason: 'The guard prevents the reported negative result.',
      },
    ],
  };
}
function response(packetHash: string, results: readonly unknown[]): Uint8Array {
  return Buffer.from(JSON.stringify({ version: 1, packetHash, results }));
}

describe('bounded finding revalidation safety contracts', () => {
  it('accepts two local fixes, preserves a still-valid failure and abstains on absent cross-file scope', async () => {
    const taxSource = [
      'export function tax(amount: number, exempt: boolean, rate: number) {',
      '  const taxable = Math.max(0, amount);',
      '  if (exempt) return 0;',
      '  return taxable * rate;',
      '}',
      '',
    ].join('\n');
    const plan = await planFindingRevalidation(
      input([
        target(0),
        target(1, { message: 'Exempt customers must pay zero tax.' }),
        target(2, { message: 'A rate above one must be rejected.' }),
        target(3, {
          message: 'The caller must select the configured jurisdiction rate.',
        }),
      ]),
      ports(taxSource)
    );
    const prepared = prepareLifecycleRequest(plan.packets[0]!, plan.outputCap);
    const citation = (line: number, quote: string, reason: string) => [
      {
        path: 'src/tax.ts',
        blobOid,
        startLine: line,
        endLine: line,
        quote,
        reason,
      },
    ];
    const replies = [
      {
        ...result(0),
        evidence: citation(
          2,
          'const taxable = Math.max(0, amount);',
          'Clamps negative taxable base.'
        ),
      },
      {
        ...result(1),
        failureCondition: 'Exempt customers previously paid tax.',
        fixExplanation: 'The exemption branch returns zero before multiplying.',
        evidence: citation(
          3,
          'if (exempt) return 0;',
          'The exemption returns zero.'
        ),
      },
      {
        ...result(2, 'still_valid'),
        failureCondition: 'Rates above one are accepted.',
        fixExplanation:
          'The multiplication accepts the supplied rate without validation.',
        evidence: citation(
          4,
          'return taxable * rate;',
          'There is no validation before rate multiplication.'
        ),
      },
      {
        ...result(3),
        scopeSufficient: false,
        fixExplanation:
          'The caller configuration is absent; elimination cannot be established.',
        evidence: citation(
          4,
          'return taxable * rate;',
          'The supplied rate originates outside this file.'
        ),
      },
    ];
    const validation = validateLifecycleResponse(
      response(prepared.packet.packetHash, replies),
      prepared,
      'saved-model',
      prepared.requestHash
    );
    expect(
      validation.valid && validation.results.map((item) => item.verdict)
    ).toEqual(['resolved', 'resolved', 'still_valid', 'uncertain']);
    expect(prepared.packet.sources).toHaveLength(1);
    expect(prepared.packet.sources[0]!.content).toBe(taxSource);
    expect(prepared.packet.sources[0]!.contentHash).toBe(
      byteHash(Buffer.from(taxSource))
    );
    expect(prepared.request).toMatchObject({
      model: 'saved-model',
      stream: true,
      store: false,
      service_tier: 'default',
      max_output_tokens: 4096,
    });
    expect(prepared.request).toMatchObject({ tools: [], tool_choice: 'none' });
  });

  it('rejects a whole batch when targets swap otherwise valid citations from separate files', async () => {
    const otherPath = 'src/other-tax.ts';
    const otherBlobOid = 'e'.repeat(40);
    const planningPorts = ports();
    const plan = await planFindingRevalidation(
      input([target(0), target(1, { originalPath: otherPath })]),
      {
        ...planningPorts,
        sourceReader: {
          read: async ({ headSha, path }) => ({
            kind: 'file',
            headSha,
            path,
            blobOid: path === otherPath ? otherBlobOid : blobOid,
            bytes: Buffer.from(source),
          }),
        },
      }
    );
    expect(plan.packets).toHaveLength(1);
    expect(plan.packets[0]!.sources).toHaveLength(2);
    const prepared = prepareLifecycleRequest(plan.packets[0]!, plan.outputCap);
    const ownCitations = [
      result(0),
      {
        ...result(1),
        evidence: [
          { ...result(1).evidence[0]!, path: otherPath, blobOid: otherBlobOid },
        ],
      },
    ];
    expect(
      validateLifecycleResponse(
        response(prepared.packet.packetHash, ownCitations),
        prepared,
        'saved-model',
        prepared.requestHash
      ).valid
    ).toBe(true);
    const swappedCitations = ownCitations.map((reply, index) => ({
      ...reply,
      evidence: ownCitations[1 - index]!.evidence,
    }));
    expect(
      validateLifecycleResponse(
        response(prepared.packet.packetHash, swappedCitations),
        prepared,
        'saved-model',
        prepared.requestHash
      )
    ).toEqual({ valid: false, reason: 'missing_or_invalid_verdict' });
  });

  it.each([
    'missing',
    'duplicate',
    'unknown',
    'quote',
    'path',
    'blob',
    'range',
    'extra-key',
    'model',
    'hash',
    'zero-evidence',
    'utf8',
    'truncated',
    'verdict-type',
  ])(
    'rejects the whole packet on %s rather than accepting a sibling fix',
    async (fault) => {
      const plan = await planFindingRevalidation(
        input([target(0), target(1)]),
        ports()
      );
      const prepared = prepareLifecycleRequest(
        plan.packets[0]!,
        plan.outputCap
      );
      let replies: unknown[] = [result(0), result(1)];
      const bad = {
        ...result(1),
        evidence: [{ ...result(1).evidence[0]! }],
      } as Record<string, unknown>;
      if (fault === 'missing') replies = [result(0)];
      else if (fault === 'duplicate') replies = [result(0), result(0)];
      else if (fault === 'unknown')
        replies = [result(0), { ...bad, targetId: 'foreign' }];
      else {
        if (fault === 'extra-key') bad.extra = true;
        if (fault === 'verdict-type') bad.verdict = ['resolved'];
        if (fault === 'zero-evidence') bad.evidence = [];
        const citation = (bad.evidence as Record<string, unknown>[])[0];
        if (citation) {
          if (fault === 'quote') citation.quote = 'fabricated';
          if (fault === 'path') citation.path = 'other.ts';
          if (fault === 'blob') citation.blobOid = 'e'.repeat(40);
          if (fault === 'range') citation.endLine = 999;
        }
        replies = [result(0), bad];
      }
      let bytes = response(prepared.packet.packetHash, replies);
      if (fault === 'utf8') bytes = new Uint8Array([0xff]);
      if (fault === 'truncated') bytes = bytes.slice(0, -3);
      const validation = validateLifecycleResponse(
        bytes,
        prepared,
        fault === 'model' ? 'other' : 'saved-model',
        fault === 'hash' ? 'wrong' : prepared.requestHash
      );
      expect(validation).toEqual({
        valid: false,
        reason: 'missing_or_invalid_verdict',
      });
    }
  );

  it('preserves BOM and CRLF bytes in full source packets', async () => {
    const content = '\uFEFFconst fixed = true;\r\n';
    const plan = await planFindingRevalidation(
      input([target(0)]),
      ports(content)
    );
    expect(plan.packets[0]!.sources[0]!.content).toBe(content);
    expect(plan.packets[0]!.sources[0]!.lineCount).toBe(1);
  });

  it('sends no secret-bearing file or claim and never infers for an empty or ineligible inventory', async () => {
    for (const [targets, content] of [
      [[], source],
      [[target(0)], `const token = "ghp_${'x'.repeat(20)}";`],
      [[target(0, { message: `password=${'z'.repeat(20)}` })], source],
      [[target(0, { hasHumanReply: true })], source],
    ] as const) {
      const plan = await planFindingRevalidation(
        input(targets),
        ports(content)
      );
      let calls = 0;
      const inference: LifecycleInference = {
        infer: async () => {
          calls++;
          throw new Error('unexpected dispatch');
        },
      };
      const run = await runFindingRevalidation(
        plan,
        inference,
        new AbortController().signal
      );
      expect(calls).toBe(0);
      expect(run.accepted).toEqual([]);
      expect(JSON.stringify(plan)).not.toContain('ghp_');
      expect(JSON.stringify(plan)).not.toContain('password=');
    }
  });

  it('keeps full inventory accounting, caps at output capacity and does not collapse equal fingerprints', async () => {
    const targets = Array.from({ length: 11 }, (_, i) =>
      target(i, { fingerprint: 'same-fingerprint' })
    );
    const setup = {
      ...input(targets),
      limits: {
        gatewayOutputTokens: 2048,
        modelOutputTokens: 8192,
        remainingWorkSlots: 2,
      },
    };
    const plan = await planFindingRevalidation(setup, ports());
    expect(plan.inventoryCount).toBe(11);
    expect(plan.dispositions).toHaveLength(11);
    expect(plan.packets.map((packet) => packet.targets.length)).toEqual([2, 2]);
    expect(
      plan.dispositions.filter((item) => item.disposition === 'capped')
    ).toHaveLength(7);
    expect(plan.participantRoster).toEqual([setup.participant]);
    const reverse = await planFindingRevalidation(
      { ...setup, targets: [...targets].reverse() },
      ports()
    );
    expect(reverse).toEqual(plan);
  });

  it('reads only the native exact-head target path and permits only an unambiguous native rename', async () => {
    const requested: string[] = [];
    const setup = input([
      target(0, {
        originalPath: 'old.ts',
        message: 'See `secret.ts` and `unrelated.ts`.',
      }),
    ]);
    const adapters = ports();
    const read: ImmutableSourceReader['read'] = async ({ headSha, path }) => {
      requested.push(`${headSha}:${path}`);
      return path === 'new.ts'
        ? { kind: 'file', headSha, path, blobOid, bytes: Buffer.from(source) }
        : { kind: 'missing' };
    };
    const plan = await planFindingRevalidation(
      {
        ...setup,
        renames: [{ previousFilename: 'old.ts', filename: 'new.ts' }],
      },
      { ...adapters, sourceReader: { read } }
    );
    expect(requested).toEqual([`${headSha}:old.ts`, `${headSha}:new.ts`]);
    expect(plan.packets[0]!.sources[0]!.inclusionReason).toBe('native_rename');
    const ambiguous = await planFindingRevalidation(
      {
        ...setup,
        renames: [
          { previousFilename: 'old.ts', filename: 'new.ts' },
          { previousFilename: 'old.ts', filename: 'other.ts' },
        ],
      },
      { ...adapters, sourceReader: { read } }
    );
    expect(ambiguous.packets).toEqual([]);
    expect(ambiguous.dispositions[0]!.reason).toBe('context_insufficient');
  });

  it('never truncates a target into a positive candidate to meet byte or output limits', async () => {
    const cases = [
      {
        setup: {
          ...input([target(0)]),
          limits: {
            gatewayOutputTokens: 1023,
            modelOutputTokens: 4096,
            remainingWorkSlots: 2,
          },
        },
        content: source,
        reason: 'verification_configuration_invalid',
      },
      {
        setup: input([target(0)]),
        content: 'x'.repeat(24 * 1024 + 1),
        reason: 'source_oversized',
      },
      {
        setup: input([target(0, { message: 'x'.repeat(4097) })]),
        content: source,
        reason: 'claim_oversized',
      },
      {
        setup: {
          ...input([target(0)]),
          limits: {
            gatewayOutputTokens: 4096,
            modelOutputTokens: 4096,
            remainingWorkSlots: 2,
            maxRequestBytes: 128,
          },
        },
        content: source,
        reason: 'request_oversized',
      },
    ];
    for (const entry of cases) {
      const plan = await planFindingRevalidation(
        entry.setup,
        ports(entry.content)
      );
      expect(plan.packets).toEqual([]);
      expect(plan.dispositions[0]!.reason).toBe(entry.reason);
    }
    const plan = await planFindingRevalidation(
      input([target(0, { severity: 'critical' })]),
      ports()
    );
    const prepared = prepareLifecycleRequest(plan.packets[0]!, plan.outputCap);
    const low = validateLifecycleResponse(
      response(prepared.packet.packetHash, [
        { ...result(0), confidence: 0.89 },
      ]),
      prepared,
      'saved-model',
      prepared.requestHash
    );
    expect(low.valid && low.results[0]!.verdict).toBe('uncertain');
    const configured = await planFindingRevalidation(
      { ...input([target(0)]), resolveConfidenceThresholds: { major: 0.7 } },
      ports()
    );
    const configuredRequest = prepareLifecycleRequest(
      configured.packets[0]!,
      configured.outputCap
    );
    const configuredVerdict = validateLifecycleResponse(
      response(configuredRequest.packet.packetHash, [
        { ...result(0), confidence: 0.75 },
      ]),
      configuredRequest,
      'saved-model',
      configuredRequest.requestHash
    );
    expect(
      configuredVerdict.valid && configuredVerdict.results[0]!.verdict
    ).toBe('resolved');
  });

  it('fails closed on incomplete inventory, prior resolve or unknown effect without inference', async () => {
    const incomplete = await planFindingRevalidation(
      { ...input([target(0)]), inventoryComplete: false },
      ports()
    );
    expect(incomplete.packets).toEqual([]);
    for (const state of ['previously_resolved', 'effect_unknown'] as const) {
      const plan = await planFindingRevalidation(input([target(0)]), {
        ...ports(),
        priorResolutionHistory: {
          read: async () => ({ historyCut: 'cut', guardVersion: '2', state }),
        },
      });
      expect(plan.packets).toEqual([]);
      expect(plan.dispositions[0]!.disposition).toBe('manual');
    }
  });

  it('makes one attempt and keeps a missing declared verifier unverified', async () => {
    const plan = await planFindingRevalidation(input([target(0)]), ports());
    let calls = 0;
    const run = await runFindingRevalidation(
      plan,
      {
        infer: async () => {
          calls++;
          throw new Error('provider raw secret');
        },
      },
      new AbortController().signal
    );
    expect(calls).toBe(1);
    expect(run.accepted).toEqual([]);
    expect(run.unverified).toEqual([
      { targetId: 'target-0', reason: 'verification_failed' },
    ]);
    const noQuorum = await runFindingRevalidation(
      {
        ...plan,
        participantRoster: [
          ...plan.participantRoster,
          {
            ...plan.participantRoster[0]!,
            voteIdentityHash: 'missing-identity',
          },
        ],
      },
      {
        infer: async () => {
          calls++;
          throw new Error('unexpected');
        },
      },
      new AbortController().signal
    );
    expect(calls).toBe(1);
    expect(noQuorum.accepted).toEqual([]);
  });
});
