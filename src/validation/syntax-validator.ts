import { getParser, Language } from '../analysis/ast/parsers';
import type Parser from 'tree-sitter';

export interface SyntaxValidationResult {
  isValid: boolean;
  skipped?: boolean;
  reason?: string;
  errors: Array<{
    type: 'ERROR' | 'MISSING';
    line: number;
    column: number;
    text?: string;
  }>;
}

function getRootNode(tree: Parser.Tree): Parser.SyntaxNode | null {
  return ((tree as any).rootNode ?? (tree as any).root) || null;
}

/**
 * Validates suggested code fixes using tree-sitter syntax parsing.
 *
 * CRITICAL: Checks BOTH node.type === 'ERROR' AND node.isMissing
 * - ERROR nodes: unparseable text (syntax errors)
 * - MISSING nodes: parser-inserted recovery tokens (unclosed braces, missing semicolons)
 * - Only checking hasError misses MISSING nodes!
 *
 * @param code - The code to validate
 * @param language - The language to parse (typescript, javascript, python, go)
 * @returns Validation result with error details or skip status
 */
export function validateSyntax(code: string, language: Language): SyntaxValidationResult {
  // Handle unsupported languages
  if (language === 'unknown' || language === 'rust') {
    return {
      isValid: true,
      skipped: true,
      reason: 'Unsupported language',
      errors: []
    };
  }

  // Get parser for language
  const parser = getParser(language);
  if (!parser) {
    debugSyntax(`parser unavailable for ${language}`);
    return validateSyntaxFallback(code, language) || {
      isValid: true,
      skipped: true,
      reason: 'Parser not available',
      errors: []
    };
  }

  let tree: Parser.Tree;
  try {
    tree = parser.parse(code);
  } catch (error) {
    debugSyntax(`parser failed for ${language}: ${(error as Error).message}`);
    return validateSyntaxFallback(code, language) || {
      isValid: true,
      skipped: true,
      reason: `Parser failed: ${(error as Error).message}`,
      errors: []
    };
  }

  const rootNode = getRootNode(tree);
  if (!rootNode) {
    debugSyntax(`parser returned no root node for ${language}`);
    return validateSyntaxFallback(code, language) || {
      isValid: true,
      skipped: true,
      reason: 'Parser returned no root node',
      errors: []
    };
  }

  const errors: Array<{
    type: 'ERROR' | 'MISSING';
    line: number;
    column: number;
    text?: string;
  }> = [];

  const visitNode = (node: Parser.SyntaxNode): void => {
    // Check for ERROR nodes (unparseable text)
    if (node.type === 'ERROR') {
      errors.push({
        type: 'ERROR',
        line: node.startPosition.row + 1, // 1-indexed
        column: node.startPosition.column + 1, // 1-indexed
        text: node.text || undefined
      });
    }

    // Check for MISSING nodes (parser recovery tokens)
    if (node.isMissing) {
      errors.push({
        type: 'MISSING',
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        text: node.text || undefined
      });
    }

    // Recursively check children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        visitNode(child);
      }
    }
  };

  visitNode(rootNode);

  return {
    isValid: errors.length === 0,
    errors
  };
}

function debugSyntax(message: string): void {
  if (process.env.MPR_DEBUG_SYNTAX === '1') {
    // eslint-disable-next-line no-console
    console.error(`[syntax] ${message}`);
  }
}

function validateSyntaxFallback(code: string, language: Language): SyntaxValidationResult | null {
  if (language === 'unknown' || language === 'rust') {
    return null;
  }

  const errors: SyntaxValidationResult['errors'] = [];
  const delimiterError = findDelimiterError(code);
  if (delimiterError) {
    errors.push(delimiterError);
  }

  const incompleteExpression = findIncompleteExpression(code, language);
  if (incompleteExpression) {
    errors.push(incompleteExpression);
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

function findIncompleteExpression(code: string, language: Language): SyntaxValidationResult['errors'][number] | null {
  const trimmed = code.trimEnd();
  if (!trimmed) {
    return null;
  }

  if (hasIncompleteTrailingCharacter(trimmed)) {
    return makeError(code, Math.max(0, trimmed.length - 1), trimmed.endsWith('{') || trimmed.endsWith('(') ? 'MISSING' : 'ERROR');
  }

  if (language === 'typescript' || language === 'javascript') {
    const duplicateDeclaration = code.match(/\b(?:const|let|var)\b[^;\n]*\s+\b(?:const|let|var)\b/);
    if (duplicateDeclaration?.index !== undefined) {
      return makeError(code, duplicateDeclaration.index, 'ERROR');
    }

    const assignmentBeforeStatement = code.match(/=\s*\n\s*(?:return|const|let|var|})/);
    if (assignmentBeforeStatement?.index !== undefined) {
      return makeError(code, assignmentBeforeStatement.index, 'ERROR');
    }
  }

  return null;
}

function hasIncompleteTrailingCharacter(value: string): boolean {
  const lastCharacter = value[value.length - 1];
  return ['=', '+', '-', '*', '/', '%', ',', '(', '{', '['].includes(lastCharacter);
}

function findDelimiterError(code: string): SyntaxValidationResult['errors'][number] | null {
  const stack: Array<{ char: string; index: number }> = [];
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < code.length; index++) {
    const char = code[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '(' || char === '{' || char === '[') {
      stack.push({ char, index });
    } else if (char === ')' || char === '}' || char === ']') {
      const opening = stack.pop();
      if (!opening || opening.char !== pairs[char]) {
        return makeError(code, index, 'ERROR');
      }
    }
  }

  if (quote) {
    return makeError(code, Math.max(0, code.length - 1), 'MISSING');
  }

  const unclosed = stack.pop();
  if (unclosed) {
    return makeError(code, unclosed.index, 'MISSING');
  }

  return null;
}

function makeError(
  code: string,
  index: number,
  type: 'ERROR' | 'MISSING'
): SyntaxValidationResult['errors'][number] {
  const before = code.slice(0, index);
  const lines = before.split('\n');

  return {
    type,
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
    text: code.trim() || undefined
  };
}
