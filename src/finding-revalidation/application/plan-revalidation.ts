import { classifyUtf8Content } from '../../context-gateway/utf8-content';
import { redactSensitiveText } from '../../utils/redaction';
import {
  ImmutableSource,
  ImmutableSourceReader,
  PacketTarget,
  PriorResolutionHistory,
  RevalidationLimits,
  RevalidationParticipant,
  RevalidationPlan,
  RevalidationReason,
  RevalidationScope,
  RevalidationSeverity,
  RevalidationTarget,
  TargetDisposition,
  TargetWitness,
  VerifyPacket,
} from '../domain/contracts';
import { resolveRevalidationConfidenceThresholds } from '../domain/resolve-confidence-policy';
import {
  byteHash,
  makeVerifyPacket,
  prepareLifecycleRequest,
  REVALIDATION_LIMITS,
  revalidationHash,
} from '../domain/packet';

export type PlanRevalidationInput = Readonly<{
  scope: RevalidationScope;
  participant: RevalidationParticipant | null;
  inventoryComplete: boolean;
  targets: readonly RevalidationTarget[];
  limits: RevalidationLimits;
  policyDigest: string;
  resolveConfidenceThresholds?: Partial<
    Readonly<Record<RevalidationSeverity, number>>
  >;
  renames?: readonly Readonly<{ previousFilename: string; filename: string }>[];
}>;
export type RevalidationPlanningPorts = Readonly<{
  sourceReader: ImmutableSourceReader;
  priorResolutionHistory: PriorResolutionHistory;
  /** Composes the existing sensitive-path predicate and repository exclusions. */
  isPathAllowed: (path: string) => boolean;
}>;
function normalizedPath(path: string): boolean {
  return (
    !!path &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.startsWith('/') &&
    path
      .split('/')
      .every((segment) => !!segment && segment !== '.' && segment !== '..')
  );
}
function witness(
  target: RevalidationTarget,
  resolutionHistory: TargetWitness['resolutionHistory']
): TargetWitness {
  return {
    targetId: target.targetId,
    threadId: target.threadId,
    fingerprint: target.fingerprint,
    parentId: target.parentId,
    parentCreatedAt: target.parentCreatedAt,
    parentUpdatedAt: target.parentUpdatedAt,
    parentBodyHash: target.parentBodyHash,
    claimHash: target.claimHash,
    commentStateHash: target.commentStateHash,
    ledgerWatermark: target.ledgerWatermark,
    originalPath: target.originalPath,
    currentPath: target.currentPath,
    originalLine: target.originalLine,
    currentLine: target.currentLine,
    severity: target.severity,
    resolutionHistory: { ...resolutionHistory },
  };
}
function ineligible(target: RevalidationTarget): RevalidationReason | null {
  if (target.isResolved) return 'native_resolved';
  if (!target.trusted || target.markerAmbiguous) return 'untrusted_target';
  if (target.hasHumanReply) return 'human_discussion';
  if (target.commandDismissed) return 'command_dismissed';
  if (target.parentEdited) return 'parent_changed';
  if (
    !target.targetId ||
    !target.threadId ||
    !target.fingerprint ||
    !target.parentId ||
    !target.parentBodyHash ||
    !target.claimHash ||
    !target.commentStateHash ||
    !target.ledgerWatermark ||
    !Number.isFinite(Date.parse(target.parentUpdatedAt)) ||
    !Number.isFinite(Date.parse(target.parentCreatedAt))
  )
    return 'untrusted_target';
  return null;
}
const severityOrder = { critical: 0, major: 1, minor: 2, unknown: 3 };
const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function parentTimestamp(target: RevalidationTarget): number {
  const parsed = Date.parse(target.parentCreatedAt);
  return Number.isFinite(parsed) ? parsed : Infinity;
}

/** Selects only native target files from immutable objects; never follows prose paths. */
export async function planFindingRevalidation(
  input: PlanRevalidationInput,
  ports: RevalidationPlanningPorts
): Promise<RevalidationPlan> {
  const scope = { ...input.scope };
  const resolveConfidenceThresholds = resolveRevalidationConfidenceThresholds(
    input.resolveConfidenceThresholds
  );
  const participant = input.participant ? { ...input.participant } : null;
  const outputCap = Math.min(
    REVALIDATION_LIMITS.outputTokens,
    input.limits.gatewayOutputTokens,
    input.limits.modelOutputTokens
  );
  const inventoryHash = revalidationHash('inventory', {
    scope,
    inventoryComplete: input.inventoryComplete,
    targets: [...input.targets].sort((a, b) => lexical(a.targetId, b.targetId)),
  });
  const dispositions: TargetDisposition[] = [];
  const groups: { targets: PacketTarget[]; sources: ImmutableSource[] }[] = [];
  const slots = Math.max(
    0,
    Math.min(
      REVALIDATION_LIMITS.packets,
      Math.floor(input.limits.remainingWorkSlots)
    )
  );
  const targetLimit = Math.min(
    REVALIDATION_LIMITS.targets,
    Math.floor(outputCap / REVALIDATION_LIMITS.targetOutputTokens)
  );
  const requestLimit = Math.min(
    REVALIDATION_LIMITS.requestBytes,
    input.limits.maxRequestBytes ?? Infinity
  );
  const sourceLimit = Math.min(
    REVALIDATION_LIMITS.sourceBytes,
    input.limits.maxSourceBytes ?? Infinity
  );
  const fileLimit = Math.min(
    REVALIDATION_LIMITS.fileBytes,
    input.limits.maxFileBytes ?? Infinity
  );
  const claimLimit = Math.min(
    REVALIDATION_LIMITS.claimBytes,
    input.limits.maxClaimBytes ?? Infinity
  );
  const maxResponseBytes = Math.min(
    REVALIDATION_LIMITS.responseBytes,
    input.limits.maxResponseBytes ?? Infinity
  );
  const configValid =
    participant &&
    participant.model.trim() &&
    participant.voteIdentityHash &&
    participant.capabilityDigest &&
    input.policyDigest &&
    Number.isInteger(input.limits.gatewayOutputTokens) &&
    Number.isInteger(input.limits.modelOutputTokens) &&
    Number.isInteger(input.limits.remainingWorkSlots) &&
    input.limits.remainingWorkSlots >= 0 &&
    Number.isInteger(outputCap) &&
    outputCap >= REVALIDATION_LIMITS.targetOutputTokens &&
    Number.isInteger(slots) &&
    Number.isInteger(requestLimit) &&
    requestLimit > 0 &&
    Number.isInteger(sourceLimit) &&
    sourceLimit > 0 &&
    Number.isInteger(fileLimit) &&
    fileLimit > 0 &&
    Number.isInteger(claimLimit) &&
    claimLimit > 0 &&
    Number.isInteger(maxResponseBytes) &&
    maxResponseBytes > 0;
  const seen = new Set<string>();
  const duplicateInventory = input.targets.some((target) => {
    if (seen.has(target.targetId)) return true;
    seen.add(target.targetId);
    return false;
  });
  const requestFits = (packet: VerifyPacket): boolean => {
    try {
      prepareLifecycleRequest(packet, outputCap, requestLimit);
      return true;
    } catch {
      return false;
    }
  };
  const sourceCache = new Map<
    string,
    Promise<{ source: ImmutableSource | null; reason: RevalidationReason }>
  >();
  const read = (
    path: string,
    inclusionReason: ImmutableSource['inclusionReason']
  ): Promise<{
    source: ImmutableSource | null;
    reason: RevalidationReason;
  }> => {
    const cached = sourceCache.get(path);
    if (cached) return cached;
    const result = (async () => {
      if (!normalizedPath(path) || !ports.isPathAllowed(path))
        return {
          source: null,
          reason: 'sensitive_context_unavailable' as const,
        };
      const result = await ports.sourceReader.read({
        headSha: scope.headSha,
        path,
        maxBytes: fileLimit,
      });
      if (result.kind !== 'file')
        return {
          source: null,
          reason:
            result.kind === 'oversized'
              ? ('source_oversized' as const)
              : result.kind === 'missing'
                ? ('context_insufficient' as const)
                : ('unsupported_source' as const),
        };
      if (
        result.headSha !== scope.headSha ||
        result.path !== path ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.blobOid)
      )
        return { source: null, reason: 'unsupported_source' as const };
      if (result.bytes.byteLength > fileLimit)
        return { source: null, reason: 'source_oversized' as const };
      const classified = classifyUtf8Content(Buffer.from(result.bytes));
      if (classified.kind !== 'text')
        return { source: null, reason: 'unsupported_source' as const };
      const content = classified.text;
      if (redactSensitiveText(content) !== content)
        return {
          source: null,
          reason: 'sensitive_context_unavailable' as const,
        };
      return {
        source: {
          headSha: scope.headSha,
          path,
          blobOid: result.blobOid,
          contentHash: byteHash(result.bytes),
          content,
          byteCount: result.bytes.byteLength,
          lineCount: classified.lineCount,
          complete: true as const,
          inclusionReason,
        },
        reason: 'verified' as const,
      };
    })();
    sourceCache.set(path, result);
    return result;
  };
  const candidates = [...input.targets].sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      parentTimestamp(a) - parentTimestamp(b) ||
      lexical(a.targetId, b.targetId)
  );
  for (const target of candidates) {
    const skip = (
      disposition: TargetDisposition['disposition'],
      reason: RevalidationReason
    ): void => {
      dispositions.push({
        targetId: target.targetId,
        disposition,
        reason,
        packetHash: null,
      });
    };
    const reason = ineligible(target);
    if (reason) {
      skip(reason === 'native_resolved' ? 'resolved' : 'manual', reason);
      continue;
    }
    if (!input.inventoryComplete || duplicateInventory) {
      skip('unavailable', 'inventory_incomplete');
      continue;
    }
    if (!participant) {
      skip('unavailable', 'verification_unavailable');
      continue;
    }
    if (!configValid) {
      skip('unavailable', 'verification_configuration_invalid');
      continue;
    }
    if (
      groups.reduce((n, group) => n + group.targets.length, 0) >=
      slots * targetLimit
    ) {
      skip('capped', 'verification_capped');
      continue;
    }
    const claim = {
      title: target.title,
      message: target.message,
      diffHunk: target.diffHunk,
    };
    if (
      [claim.title, claim.message, claim.diffHunk ?? ''].some(
        (value) => redactSensitiveText(value) !== value
      )
    ) {
      skip('unavailable', 'sensitive_context_unavailable');
      continue;
    }
    if (Buffer.byteLength(JSON.stringify(claim), 'utf8') > claimLimit) {
      skip('unsupported', 'claim_oversized');
      continue;
    }
    let history;
    try {
      history = await ports.priorResolutionHistory.read(target, scope);
    } catch {
      skip('unavailable', 'verification_unavailable');
      continue;
    }
    if (history.state === 'previously_resolved') {
      skip('manual', 'previously_resolved_thread_reopened');
      continue;
    }
    if (history.state === 'effect_unknown') {
      skip('manual', 'resolution_effect_unknown');
      continue;
    }
    if (
      !['no_prior_since_creation', 'before_cut_unobserved'].includes(
        history.state
      ) ||
      !history.historyCut ||
      !history.guardVersion
    ) {
      skip('unavailable', 'verification_unavailable');
      continue;
    }
    let selected: Awaited<ReturnType<typeof read>>;
    try {
      selected = await read(
        target.currentPath ?? target.originalPath,
        'target_file'
      );
      if (
        !selected.source &&
        selected.reason === 'context_insufficient' &&
        target.currentPath &&
        target.currentPath !== target.originalPath
      )
        selected = await read(target.originalPath, 'target_file');
      if (!selected.source && selected.reason === 'context_insufficient') {
        const renames = [
          ...new Set(
            (input.renames ?? [])
              .filter(
                (rename) => rename.previousFilename === target.originalPath
              )
              .map((rename) => rename.filename)
          ),
        ];
        if (renames.length === 1)
          selected = await read(renames[0]!, 'native_rename');
      }
    } catch {
      skip('unavailable', 'verification_unavailable');
      continue;
    }
    if (!selected.source) {
      skip('unsupported', selected.reason);
      continue;
    }
    const source = selected.source;
    const packetTarget = {
      witness: witness(target, history),
      claim,
      sourcePath: source.path,
    };
    if (source.byteCount > sourceLimit) {
      skip('unsupported', 'source_oversized');
      continue;
    }
    const singleTargetPacket = makeVerifyPacket({
      scope,
      participant,
      targets: [packetTarget],
      sources: [source],
      policyDigest: input.policyDigest,
      resolveConfidenceThresholds,
    });
    if (!requestFits(singleTargetPacket)) {
      skip('unsupported', 'request_oversized');
      continue;
    }
    // Prefer a packet already containing this file, then the earliest packet.
    const availableGroups = groups
      .map((group, index) => ({ group, index }))
      .sort(
        (a, b) =>
          Number(b.group.sources.some((item) => item.path === source.path)) -
            Number(a.group.sources.some((item) => item.path === source.path)) ||
          a.index - b.index
      );
    let packed = false;
    for (const { group } of [
      ...availableGroups,
      ...(groups.length < slots
        ? [
            {
              group: {
                targets: [] as PacketTarget[],
                sources: [] as ImmutableSource[],
              },
              index: groups.length,
            },
          ]
        : []),
    ]) {
      const sources = group.sources.some((item) => item.path === source.path)
        ? group.sources
        : [...group.sources, source];
      const targets = [...group.targets, packetTarget];
      if (
        targets.length > targetLimit ||
        sources.length > REVALIDATION_LIMITS.files ||
        sources.reduce((n, item) => n + item.byteCount, 0) > sourceLimit
      )
        continue;
      const packet = makeVerifyPacket({
        scope,
        participant,
        targets,
        sources,
        policyDigest: input.policyDigest,
        resolveConfidenceThresholds,
      });
      if (!requestFits(packet)) continue;
      if (!groups.includes(group)) groups.push(group);
      group.targets = targets;
      group.sources = sources;
      packed = true;
      break;
    }
    if (!packed) skip('capped', 'verification_capped');
  }
  const packets = groups.map((group) =>
    makeVerifyPacket({
      scope,
      participant: participant!,
      targets: group.targets,
      sources: group.sources,
      policyDigest: input.policyDigest,
      resolveConfidenceThresholds,
    })
  );
  for (const packet of packets)
    for (const target of packet.targets)
      dispositions.push({
        targetId: target.witness.targetId,
        disposition: 'eligible',
        reason: 'verified',
        packetHash: packet.packetHash,
      });
  dispositions.sort((a, b) => lexical(a.targetId, b.targetId));
  return {
    packets,
    dispositions,
    inventoryHash,
    inventoryCount: input.targets.length,
    participantRoster: participant ? [participant] : [],
    outputCap,
    maxResponseBytes,
  };
}
