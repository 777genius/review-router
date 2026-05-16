import {
  ActionMemoryCandidateRequest,
  ActionMemoryCommand,
} from '../control-plane/memory';

export type ParsedMemoryInstruction =
  | {
      readonly type: 'candidate';
      readonly intent: ActionMemoryCandidateRequest['intent'];
      readonly extractionMethod: ActionMemoryCandidateRequest['extractionMethod'];
      readonly requestedScope: 'repository' | 'workspace';
      readonly candidateBody: string;
    }
  | {
      readonly type: 'command';
      readonly command: ActionMemoryCommand;
    };

export interface ParsedMemoryInteraction {
  readonly instructions: readonly ParsedMemoryInstruction[];
  readonly invalidReason?: string;
}

const memoryItemIdPattern = '(mem_[A-Za-z0-9_-]+)';
const suggestionIdPattern = '(mem_suggestion_[A-Za-z0-9_-]+)';

export function hasMemoryInteraction(body: string | null | undefined): boolean {
  return parseMemoryInteraction(body).instructions.length > 0;
}

export function parseMemoryInteraction(
  body: string | null | undefined
): ParsedMemoryInteraction {
  const trimmed = normalizeBody(body);
  if (!trimmed) {
    return { instructions: [] };
  }

  const command = parseMemoryCommand(trimmed);
  if (command) {
    return { instructions: [{ type: 'command', command }] };
  }

  const explicit = parseExplicitRememberCommand(trimmed);
  if (explicit) {
    return validateCandidate(explicit);
  }

  const natural = parseNaturalLanguageRemember(trimmed);
  if (natural) {
    return validateCandidate(natural);
  }

  return { instructions: [] };
}

export function memoryScopeLabel(scope: 'repository' | 'workspace'): string {
  return scope === 'repository' ? 'repository' : 'workspace';
}

export function memoryCommandLabel(command: ActionMemoryCommand): string {
  switch (command.kind) {
    case 'confirm_suggestion':
      return `confirm ${command.suggestionId}`;
    case 'reject_suggestion':
      return `reject ${command.suggestionId}`;
    case 'disable_memory':
      return `disable ${command.memoryItemId}`;
    case 'forget_memory':
      return `delete ${command.memoryItemId}`;
    case 'list_memory':
      return `list ${command.view}`;
  }
}

function parseMemoryCommand(body: string): ActionMemoryCommand | null {
  const confirm = new RegExp(
    `^/rr\\s+(?:remember|confirm-memory|confirm\\s+memory)\\s+${suggestionIdPattern}\\b`,
    'i'
  ).exec(body);
  if (confirm?.[1]) {
    return { kind: 'confirm_suggestion', suggestionId: confirm[1] };
  }

  const reject = new RegExp(
    `^/rr\\s+(?:reject-memory|reject\\s+memory)\\s+${suggestionIdPattern}\\b[\\s:,-]*(.*)$`,
    'is'
  ).exec(body);
  if (reject?.[1]) {
    const reason = cleanCandidateText(reject[2] || '');
    return {
      kind: 'reject_suggestion',
      suggestionId: reject[1],
      ...(reason ? { reason } : {}),
    };
  }

  const disable = new RegExp(
    `^/rr\\s+(?:disable-memory|disable\\s+memory)\\s+${memoryItemIdPattern}\\b`,
    'i'
  ).exec(body);
  if (disable?.[1]) {
    return { kind: 'disable_memory', memoryItemId: disable[1] };
  }

  const forget = new RegExp(
    `^/rr\\s+(?:forget|forget-memory|delete-memory|delete\\s+memory)\\s+${memoryItemIdPattern}\\b`,
    'i'
  ).exec(body);
  if (forget?.[1]) {
    return { kind: 'forget_memory', memoryItemId: forget[1] };
  }

  const list = /^\/rr\s+(?:memory|mem)\s+(active|pending|list)\b/i.exec(body);
  if (list?.[1]) {
    return {
      kind: 'list_memory',
      view: list[1].toLowerCase() === 'pending' ? 'pending' : 'active',
    };
  }

  return null;
}

function parseExplicitRememberCommand(
  body: string
): Extract<ParsedMemoryInstruction, { type: 'candidate' }> | null {
  const match =
    /^\/rr\s+remember\s+(repo|repository|project|workspace|team)\b[\s:,-]+([\s\S]+)$/i.exec(
      body
    );
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    type: 'candidate',
    intent: 'explicit_command',
    extractionMethod: 'explicit_command',
    requestedScope: parseRequestedScope(match[1]),
    candidateBody: cleanCandidateText(match[2]),
  };
}

function parseNaturalLanguageRemember(
  body: string
): Extract<ParsedMemoryInstruction, { type: 'candidate' }> | null {
  const english =
    /^(?:remember|save)\s+(?:this\s+)?(?:for\s+)?(?:this\s+)?(repo|repository|project|workspace|team)\s*[:,-]\s*([\s\S]+)$/i.exec(
      body
    ) ||
    /^(?:remember|save)\s+(?:this\s+)?(?:for\s+)?(?:this\s+)?(repo|repository|project|workspace|team)\s+([\s\S]+)$/i.exec(
      body
    );
  if (english?.[1] && english[2]) {
    return {
      type: 'candidate',
      intent: 'explicit_natural_language',
      extractionMethod: 'explicit_natural_language',
      requestedScope: parseRequestedScope(english[1]),
      candidateBody: cleanCandidateText(english[2]),
    };
  }

  const russian =
    /^(?:запомни|сохрани)\s+(?:это\s+)?(?:для\s+)?(проекта|репозитория|репы|workspace|воркспейса|команды)\s*[:,-]\s*([\s\S]+)$/i.exec(
      body
    ) ||
    /^(?:запомни|сохрани)\s+(?:это\s+)?(?:для\s+)?(проекта|репозитория|репы|workspace|воркспейса|команды)\s+([\s\S]+)$/i.exec(
      body
    );
  if (russian?.[1] && russian[2]) {
    return {
      type: 'candidate',
      intent: 'explicit_natural_language',
      extractionMethod: 'explicit_natural_language',
      requestedScope: parseRequestedScope(russian[1]),
      candidateBody: cleanCandidateText(russian[2]),
    };
  }

  return null;
}

function validateCandidate(
  instruction: Extract<ParsedMemoryInstruction, { type: 'candidate' }>
): ParsedMemoryInteraction {
  if (!instruction.candidateBody) {
    return { instructions: [], invalidReason: 'memory text is empty' };
  }
  if (instruction.candidateBody.length > 2000) {
    return { instructions: [], invalidReason: 'memory text is too long' };
  }
  if (looksUnsafeCandidateText(instruction.candidateBody)) {
    return {
      instructions: [],
      invalidReason:
        'memory text looks like code, diff, secret material, or raw prompt data',
    };
  }
  return { instructions: [instruction] };
}

function parseRequestedScope(value: string): 'repository' | 'workspace' {
  const normalized = value.toLowerCase();
  return normalized === 'workspace' ||
    normalized === 'team' ||
    normalized === 'воркспейса' ||
    normalized === 'команды'
    ? 'workspace'
    : 'repository';
}

function normalizeBody(body: string | null | undefined): string {
  return (body || '').replace(/\r\n/g, '\n').trim();
}

function cleanCandidateText(value: string): string {
  return value
    .replace(/^>\s?.*$/gm, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\|[-:| ]+\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksUnsafeCandidateText(value: string): boolean {
  return (
    /(?:diff --git|@@\s+-\d+|\+\+\+\s|---\s)/.test(value) ||
    /(?:BEGIN|END)\s+(?:RSA|OPENSSH|PRIVATE)\s+KEY/i.test(value) ||
    /(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+/.test(value) ||
    /(?:system|assistant|developer)\s*:/i.test(value) ||
    value.split('\n').filter((line) => /^\s*[+->]/.test(line)).length > 4
  );
}
