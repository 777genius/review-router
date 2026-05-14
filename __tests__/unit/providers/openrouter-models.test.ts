import {
  getBestFreeModels,
  PREFERRED_OPENROUTER_FREE_MODELS,
} from '../../../src/providers/openrouter-models';

describe('OpenRouter free model selection', () => {
  it('prefers configured concrete free models with quorum suffixes', async () => {
    const models = await getBestFreeModels(3);

    expect(models).toEqual([
      `${PREFERRED_OPENROUTER_FREE_MODELS[0]}#1`,
      `${PREFERRED_OPENROUTER_FREE_MODELS[1]}#2`,
      `${PREFERRED_OPENROUTER_FREE_MODELS[2]}#3`,
    ]);
  });

  it('cycles preferred free models when more instances are requested', async () => {
    const models = await getBestFreeModels(4);

    expect(models[3]).toBe(`${PREFERRED_OPENROUTER_FREE_MODELS[0]}#4`);
  });
});
