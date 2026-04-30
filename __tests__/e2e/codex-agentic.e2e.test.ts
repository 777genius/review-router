import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const runCodexE2E = process.env.RUN_CODEX_E2E === '1';

describe('Codex agentic context e2e', () => {
  (runCodexE2E ? it : it.skip)(
    'reads related files in read-only mode and returns schema-valid JSON',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-agentic-e2e-'));
      const schemaPath = path.join(dir, 'findings.schema.json');
      const outputPath = path.join(dir, 'codex-output.json');

      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src/related.ts'),
        'export const MARKER = "agentic-context-ok";\n'
      );
      fs.writeFileSync(
        path.join(dir, 'src/app.ts'),
        'export const value = 1;\n'
      );
      fs.writeFileSync(
        schemaPath,
        JSON.stringify({
          type: 'object',
          additionalProperties: false,
          required: ['findings'],
          properties: {
            findings: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'file',
                  'line',
                  'severity',
                  'title',
                  'message',
                  'suggestion',
                ],
                properties: {
                  file: { type: 'string' },
                  line: { type: 'integer' },
                  severity: {
                    type: 'string',
                    enum: ['critical', 'major', 'minor'],
                  },
                  title: { type: 'string' },
                  message: { type: 'string' },
                  suggestion: { type: ['string', 'null'] },
                },
              },
            },
          },
        })
      );

      spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });

      const result = spawnSync(
        'codex',
        [
          'exec',
          '--model',
          'gpt-5.4-mini',
          '--sandbox',
          'read-only',
          '--ephemeral',
          '--ignore-user-config',
          '-c',
          'approval_policy=never',
          '-c',
          'model_reasoning_effort="low"',
          '--json',
          '--output-schema',
          schemaPath,
          '--output-last-message',
          outputPath,
          'Read src/related.ts before answering. Return no findings. Output must match the schema.',
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 120000,
        }
      );

      expect(result.status).toBe(0);

      const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(output).toEqual({ findings: [] });

      const readRelated = result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .some((line) => {
          try {
            const event = JSON.parse(line);
            return (
              event?.item?.type === 'command_execution' &&
              String(event.item.command).includes('src/related.ts')
            );
          } catch {
            return false;
          }
        });

      expect(readRelated).toBe(true);
    }
  );
});
