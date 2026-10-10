import Ajv2020, { type AnySchema } from 'ajv/dist/2020';

export type CodexModelProvider = 'openai' | 'openrouter' | 'mimo';

export function supportsCliOutputSchema(
  modelProvider: CodexModelProvider | undefined
): boolean {
  // MiMo's Responses endpoint rejects text.format=json_schema. Other
  // providers retain Codex's native structured output enforcement.
  return modelProvider !== 'mimo';
}

export function assertJsonMatchesSchema(
  content: string,
  schema: unknown,
  kind: 'review' | 'structured'
): void {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(
      `Codex CLI returned invalid ${kind} JSON: response was not valid JSON`
    );
  }
  try {
    const validate = new Ajv2020({
      strict: true,
      allowUnionTypes: true,
    }).compile(schema as AnySchema);
    if ('$async' in validate) {
      throw new Error('Asynchronous output schemas are unsupported');
    }
    if (validate(value)) return;
  } catch {
    throw new Error(
      `Codex CLI returned invalid ${kind} JSON: output schema could not be validated`
    );
  }
  throw new Error(
    `Codex CLI returned invalid ${kind} JSON: output does not match schema`
  );
}
