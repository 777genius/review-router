import { PricingService } from '../../../src/cost/pricing';

describe('PricingService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('negative-caches a failed pricing refresh', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false });
    global.fetch = fetchMock as typeof fetch;
    const pricing = new PricingService('key');

    await pricing.getPricing('provider/model-a');
    await pricing.getPricing('provider/model-b');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight refresh across concurrent callers', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    const fetchMock = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    global.fetch = fetchMock as typeof fetch;
    const pricing = new PricingService('key');

    const first = pricing.getPricing('provider/model-a');
    const second = pricing.getPricing('provider/model-a');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch?.({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'provider/model-a',
            pricing: { prompt: '0.000001', completion: '0.000002' },
          },
        ],
      }),
    });

    await expect(first).resolves.toMatchObject({ promptPrice: 1 });
    await expect(second).resolves.toMatchObject({ completionPrice: 2 });
  });
});
