import { Severity } from '../types';

export interface SeverityDisplay {
  emoji: string;
  label: string;
  rank: number;
  description: string;
}

const DISPLAYS: Record<Severity, SeverityDisplay> = {
  critical: {
    emoji: '🔴',
    label: 'Critical',
    rank: 3,
    description: 'blocks merge; security, data loss, or production breakage risk',
  },
  major: {
    emoji: '🟡',
    label: 'Major',
    rank: 2,
    description: 'should fix before merge; correctness, reliability, or maintainability risk',
  },
  minor: {
    emoji: '🔵',
    label: 'Minor',
    rank: 1,
    description: 'non-blocking improvement; cleanup, clarity, or small maintainability issue',
  },
};

export function getSeverityDisplay(severity: Severity): SeverityDisplay {
  return DISPLAYS[severity];
}

export function compareSeverityDesc(a: Severity, b: Severity): number {
  return DISPLAYS[b].rank - DISPLAYS[a].rank;
}

export function severityHeading(severity: Severity, title: string): string {
  const display = getSeverityDisplay(severity);
  return `${display.emoji} ${display.label} - ${title}`;
}

export function severityLine(severity: Severity): string {
  const display = getSeverityDisplay(severity);
  return `**Severity:** ${display.emoji} **${display.label}** - ${display.description}.`;
}
