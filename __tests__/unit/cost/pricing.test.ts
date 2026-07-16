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
});
