import { RevalidationSeverity } from './contracts';

const DEFAULT_RESOLVE_CONFIDENCE: Readonly<
  Record<RevalidationSeverity, number>
> = Object.freeze({ critical: 0.9, major: 0.85, minor: 0.8, unknown: 0.9 });

/** Preserves the existing lifecycle override semantics, including configured zero. */
export function resolveRevalidationConfidenceThresholds(
  overrides?: Partial<Readonly<Record<RevalidationSeverity, number>>>
): Readonly<Record<RevalidationSeverity, number>> {
  const thresholds = { ...DEFAULT_RESOLVE_CONFIDENCE };
  for (const severity of Object.keys(thresholds) as RevalidationSeverity[]) {
    const value = overrides?.[severity];
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1
    )
      thresholds[severity] = value;
  }
  return Object.freeze(thresholds);
}
