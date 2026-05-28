import * as fs from 'fs';
import * as yaml from 'js-yaml';

describe('Codex OAuth rotating action metadata', () => {
  it('keeps the action as a single Node entrypoint with no pre/post hooks', () => {
    const action = yaml.load(fs.readFileSync('action.yml', 'utf8')) as {
      inputs?: Record<string, unknown>;
      runs?: Record<string, unknown>;
    };

    expect(action.inputs).toHaveProperty('auth-json');
    expect(action.inputs).toHaveProperty('provider-instance-id');
    expect(action.inputs).toHaveProperty('workflow-schema-version');
    expect(action.inputs).toHaveProperty('claude-code-oauth-token');
    expect(action.inputs).toHaveProperty('openrouter-api-key');
    expect(action.runs).toMatchObject({
      using: 'node24',
      main: 'action-dist/index.cjs',
    });
    expect(action.runs).not.toHaveProperty('pre');
    expect(action.runs).not.toHaveProperty('pre-if');
    expect(action.runs).not.toHaveProperty('post');
    expect(action.runs).not.toHaveProperty('post-if');
  });
});
