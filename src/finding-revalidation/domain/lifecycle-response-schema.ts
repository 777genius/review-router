/** Provider-neutral syntax only; witness, quorum and literal grounding remain validator-owned. */
const text = { type: 'string' } as const;
export const lifecycleResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', enum: [1] },
    packetHash: text,
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: text,
          fingerprint: text,
          verdict: {
            type: 'string',
            enum: ['resolved', 'still_valid', 'uncertain'],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          scopeSufficient: { type: 'boolean' },
          failureCondition: text,
          fixExplanation: text,
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: text,
                blobOid: text,
                startLine: { type: 'integer' },
                endLine: { type: 'integer' },
                quote: text,
                reason: text,
              },
              required: [
                'path',
                'blobOid',
                'startLine',
                'endLine',
                'quote',
                'reason',
              ],
            },
          },
        },
        required: [
          'targetId',
          'fingerprint',
          'verdict',
          'confidence',
          'scopeSufficient',
          'failureCondition',
          'fixExplanation',
          'evidence',
        ],
      },
    },
  },
  required: ['version', 'packetHash', 'results'],
} as const;
