import { getParser, Language } from '../analysis/ast/parsers';
import type Parser from 'tree-sitter';

/**
 * Result of comparing two ASTs for structural equivalence
 */
export interface ASTComparisonResult {
  /** Whether the ASTs are structurally equivalent */
  equivalent: boolean;
  /** Reason for non-equivalence (if false) */
  reason?: string;
  /** How deep the comparison went */
  comparisonDepth?: number;
}

/**
 * Node types to treat as "value-only" - compare type but not content
 * These represent identifiers and literals where the specific value
 * doesn't matter for structural equivalence
 */
const VALUE_ONLY_TYPES = new Set([
  // Identifiers
  'identifier',
  'property_identifier',
  'type_identifier',
  // Literals
  'string',
  'number',
  'true',
  'false',
  'null',
  'template_string',
  'regex',
  // Python-specific
  'integer',
  'float',
  'string_content',
  // JavaScript-specific
  'number_literal',
  'string_literal',
]);

/**
 * Maximum recursion depth for AST comparison
 * Prevents infinite loops on malformed ASTs or extremely deep nesting
 */
const MAX_COMPARISON_DEPTH = 1000;

function getRootNode(tree: Parser.Tree): Parser.SyntaxNode | null {
  return ((tree as any).rootNode ?? (tree as any).root) || null;
}

/**
 * Check if a node is a value-only type (identifier or literal)
 * Value-only types are compared by structure, not by actual content
 */
function isValueOnlyNode(node: Parser.SyntaxNode): boolean {
  return VALUE_ONLY_TYPES.has(node.type);
}

/**
 * Check if a tree-sitter tree has parse errors
 */
function hasParseErrors(tree: Parser.Tree): boolean {
  const rootNode = getRootNode(tree);
  if (!rootNode) {
    return true;
  }

  const visitNode = (node: Parser.SyntaxNode): boolean => {
    // ERROR nodes indicate unparseable text
    if (node.type === 'ERROR') {
      debugAst(`ERROR node: ${node.text}`);
      return true;
    }

    // MISSING nodes indicate parser recovery (inserted tokens)
    if (node.isMissing) {
      debugAst(`MISSING node: type=${node.type}; text=${node.text}`);
      return true;
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && visitNode(child)) {
        return true;
      }
    }

    return false;
  };

  return visitNode(rootNode);
}

function debugAst(message: string): void {
  if (process.env.MPR_DEBUG_AST === '1') {
    // eslint-disable-next-line no-console
    console.error(`[ast] ${message}`);
  }
}

/**
 * Recursively compare two syntax nodes for structural equivalence
 *
 * @param node1 First node to compare
 * @param node2 Second node to compare
 * @param depth Current recursion depth
 * @returns Comparison result with mismatch details
 */
function compareNodes(
  node1: Parser.SyntaxNode,
  node2: Parser.SyntaxNode,
  depth: number = 0
): { equivalent: boolean; reason?: string; maxDepth: number } {
  const maxDepth = Math.max(depth, 0);

  // Prevent infinite recursion on extremely deep or malformed ASTs
  if (depth > MAX_COMPARISON_DEPTH) {
    return {
      equivalent: false,
      reason: `Maximum comparison depth exceeded (${MAX_COMPARISON_DEPTH})`,
      maxDepth
    };
  }

  // Different node types = not equivalent
  // Exception: value-only types match if both are value-only
  if (node1.type !== node2.type) {
    // Both are value-only types - check if they're in the same category
    const node1IsValueOnly = isValueOnlyNode(node1);
    const node2IsValueOnly = isValueOnlyNode(node2);

    if (!node1IsValueOnly || !node2IsValueOnly) {
      return {
        equivalent: false,
        reason: `Node type mismatch at depth ${depth}: ${node1.type} vs ${node2.type}`,
        maxDepth
      };
    }
  }

  // Different total child counts = not equivalent
  // We compare ALL children (named + unnamed) to catch operator/keyword differences
  if (node1.childCount !== node2.childCount) {
    return {
      equivalent: false,
      reason: `Child count mismatch at depth ${depth}: ${node1.childCount} vs ${node2.childCount} children (node type: ${node1.type})`,
      maxDepth
    };
  }

  // If this is a value-only node (identifier or literal), structure matches
  // Don't compare actual text content
  if (isValueOnlyNode(node1) && isValueOnlyNode(node2)) {
    return { equivalent: true, maxDepth: depth };
  }

  // Recursively compare ALL children (named and unnamed)
  // Unnamed nodes include operators (+, -, etc.) and keywords (const, let, etc.)
  // which ARE structurally significant
  let deepestDepth = depth;
  for (let i = 0; i < node1.childCount; i++) {
    const child1 = node1.child(i);
    const child2 = node2.child(i);

    if (!child1 || !child2) {
      return {
        equivalent: false,
        reason: `Missing child at index ${i}, depth ${depth}`,
        maxDepth: deepestDepth
      };
    }

    const childResult = compareNodes(child1, child2, depth + 1);
    deepestDepth = Math.max(deepestDepth, childResult.maxDepth);

    if (!childResult.equivalent) {
      return {
        equivalent: false,
        reason: childResult.reason,
        maxDepth: deepestDepth
      };
    }
  }

  return { equivalent: true, maxDepth: deepestDepth };
}

/**
 * Compare two code snippets for structural equivalence using AST comparison
 *
 * Two code snippets are considered equivalent if:
 * - They parse without errors
 * - Their AST node types match
 * - Their child node counts match
 * - Child nodes recursively match
 *
 * Ignored differences:
 * - Whitespace and formatting
 * - Variable/function/property names
 * - Literal values (numbers, strings, booleans)
 * - Comments (not in AST)
 *
 * @param code1 First code snippet
 * @param code2 Second code snippet
 * @param language Programming language for parsing
 * @returns Comparison result with equivalence status and details
 */
export function areASTsEquivalent(
  code1: string,
  code2: string,
  language: Language
): ASTComparisonResult {
  // Check for unsupported language
  if (language === 'unknown') {
    return {
      equivalent: false,
      reason: 'Unsupported language: unknown'
    };
  }

  const parser1 = getParser(language);
  const parser2 = getParser(language);
  if (!parser1 || !parser2) {
    return compareWithTokenFallback(code1, code2, language) || {
      equivalent: false,
      reason: `Unsupported language: ${language}`
    };
  }

  // Parse both code snippets
  let tree1: Parser.Tree;
  let tree2: Parser.Tree;
  try {
    tree1 = parser1.parse(code1);
    tree2 = parser2.parse(code2);
  } catch (error) {
    return {
      equivalent: false,
      reason: `Parser failed: ${(error as Error).message}`
    };
  }

  // Check for parse errors in first code
  const tree1HasErrors = hasParseErrors(tree1);
  const tree2HasErrors = hasParseErrors(tree2);
  if (tree1HasErrors || tree2HasErrors) {
    const code1HasObviousSyntaxError = hasObviousSyntaxError(code1, language);
    const code2HasObviousSyntaxError = hasObviousSyntaxError(code2, language);

    if (code1HasObviousSyntaxError) {
      return {
        equivalent: false,
        reason: 'Parse error in code1'
      };
    }

    if (code2HasObviousSyntaxError) {
      return {
        equivalent: false,
        reason: 'Parse error in code2'
      };
    }

    const fallbackResult = compareWithTokenFallback(code1, code2, language);
    if (fallbackResult) {
      return fallbackResult;
    }
  }

  if (tree1HasErrors) {
    const reparsedTree = parseWithFreshParser(code1, language);
    if (reparsedTree && !hasParseErrors(reparsedTree)) {
      tree1 = reparsedTree;
    } else {
      return {
        equivalent: false,
        reason: 'Parse error in code1'
      };
    }
  }

  // Check for parse errors in second code
  if (tree2HasErrors) {
    const reparsedTree = parseWithFreshParser(code2, language);
    if (reparsedTree && !hasParseErrors(reparsedTree)) {
      tree2 = reparsedTree;
    } else {
      return {
        equivalent: false,
        reason: 'Parse error in code2'
      };
    }
  }

  // Compare AST structures
  const root1 = getRootNode(tree1);
  const root2 = getRootNode(tree2);
  if (!root1 || !root2) {
    return {
      equivalent: false,
      reason: 'Parser returned no root node'
    };
  }

  const result = compareNodes(root1, root2);

  return {
    equivalent: result.equivalent,
    reason: result.reason,
    comparisonDepth: result.maxDepth
  };
}

function parseWithFreshParser(code: string, language: Language): Parser.Tree | null {
  const parser = getParser(language);
  if (!parser) {
    return null;
  }

  try {
    return parser.parse(code);
  } catch {
    return null;
  }
}

function compareWithTokenFallback(
  code1: string,
  code2: string,
  language: Language
): ASTComparisonResult | null {
  if (hasObviousSyntaxError(code1, language) || hasObviousSyntaxError(code2, language)) {
    return null;
  }

  const tokens1 = normalizeStructuralTokens(code1);
  const tokens2 = normalizeStructuralTokens(code2);
  if (tokens1.length === 0 || tokens2.length === 0) {
    return null;
  }

  if (tokens1.join('\u0000') === tokens2.join('\u0000')) {
    return {
      equivalent: true,
      comparisonDepth: Math.max(1, tokens1.length)
    };
  }

  if (tokens1.length !== tokens2.length) {
    return {
      equivalent: false,
      reason: `Child count mismatch in token fallback: ${tokens1.length} vs ${tokens2.length}`,
      comparisonDepth: Math.max(tokens1.length, tokens2.length)
    };
  }

  return {
    equivalent: false,
    reason: 'Node type mismatch in token fallback',
    comparisonDepth: tokens1.length
  };
}

function normalizeStructuralTokens(code: string): string[] {
  return code
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|==={0,1}|!==?|=>|[{}()[\].,;:+\-*/%=<>]/g)
    ?.map(token => {
      if (/^["']/.test(token)) return 'STRING';
      if (/^\d/.test(token)) return 'NUMBER';
      if (token === 'true' || token === 'false') return 'BOOLEAN';
      if (/^[A-Za-z_$]/.test(token) && !isStructuralKeyword(token)) return 'IDENTIFIER';
      return token;
    }) || [];
}

function isStructuralKeyword(token: string): boolean {
  return new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'while',
    'for',
    'class',
    'def',
    'async',
    'await',
  ]).has(token);
}

function hasObviousSyntaxError(code: string, language: Language): boolean {
  const trimmed = code.trim();
  if (!trimmed) {
    return false;
  }

  if (hasIncompleteTrailingCharacter(trimmed)) {
    return true;
  }

  if (language === 'typescript' || language === 'javascript') {
    if (/\b(?:const|let|var)\b[^;\n]*\s+\b(?:const|let|var)\b/.test(trimmed)) {
      return true;
    }
    if (/=\s*\n\s*(?:return|const|let|var|})/.test(code)) {
      return true;
    }
  }

  return hasUnbalancedDelimiters(trimmed);
}

function hasIncompleteTrailingCharacter(value: string): boolean {
  const lastCharacter = value[value.length - 1];
  return ['=', '+', '-', '*', '/', '%', ',', '(', '{', '['].includes(lastCharacter);
}

function hasUnbalancedDelimiters(code: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  let quote: string | null = null;
  let escaped = false;

  for (const char of code) {
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
      stack.push(char);
    } else if (char === ')' || char === '}' || char === ']') {
      if (stack.pop() !== pairs[char]) {
        return true;
      }
    }
  }

  return quote !== null || stack.length > 0;
}
