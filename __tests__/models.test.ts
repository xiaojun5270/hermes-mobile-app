// __tests__/models.test.ts
import {
  capabilityBadges,
  formatContext,
  getModelInfo,
  getModelOptions,
  hintBadges,
  isModelUnavailable,
  modelDisplayName,
  pricingLine,
  setMainModel,
  type ProviderRow,
} from '../src/api/models';
import { CookieJar } from '../src/api/cookieJar';
import { RestClient } from '../src/api/restClient';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      json: async () => body,
    } as unknown as Response;
  };
  return Object.assign(fn, { calls });
}

function client(f: ReturnType<typeof fakeFetch>) {
  return new RestClient('http://h', new CookieJar(), f as any);
}

describe('models api', () => {
  it('getModelInfo hits GET /api/model/info', async () => {
    const f = fakeFetch(200, {
      model: 'anthropic/claude-opus-4.7',
      provider: 'openrouter',
      auto_context_length: 200000,
      config_context_length: 0,
      effective_context_length: 200000,
      capabilities: { supports_tools: true, supports_vision: true },
    });
    const info = await getModelInfo(client(f));
    expect(f.calls[0].url).toBe('http://h/api/model/info');
    expect(f.calls[0].init.method).toBeUndefined(); // GET
    expect(info.model).toBe('anthropic/claude-opus-4.7');
    expect(info.effective_context_length).toBe(200000);
  });

  it('getModelOptions hits GET /api/model/options and returns provider rows', async () => {
    const f = fakeFetch(200, {
      providers: [
        {
          slug: 'openrouter',
          name: 'OpenRouter',
          is_current: true,
          is_user_defined: false,
          models: ['anthropic/claude-opus-4.7'],
          total_models: 1,
          source: 'built-in',
          authenticated: true,
          pricing: {
            'anthropic/claude-opus-4.7': { input: '$3.00', output: '$15.00', cache: '$0.30', free: false },
          },
        },
      ],
      model: 'anthropic/claude-opus-4.7',
      provider: 'openrouter',
    });
    const res = await getModelOptions(client(f));
    expect(f.calls[0].url).toBe('http://h/api/model/options');
    expect(res.providers[0].slug).toBe('openrouter');
    expect(res.providers[0].pricing?.['anthropic/claude-opus-4.7'].input).toBe('$3.00');
  });

  it('setMainModel POSTs scope main with confirm flag defaulting false', async () => {
    const f = fakeFetch(200, { ok: true, scope: 'main', provider: 'nous', model: 'Hermes-4-405B' });
    const res = await setMainModel(client(f), 'nous', 'Hermes-4-405B');
    expect(f.calls[0].url).toBe('http://h/api/model/set');
    expect(f.calls[0].init.method).toBe('POST');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({
      scope: 'main',
      provider: 'nous',
      model: 'Hermes-4-405B',
      confirm_expensive_model: false,
    });
    expect(res.ok).toBe(true);
  });

  it('setMainModel passes confirm_expensive_model true on re-POST', async () => {
    const f = fakeFetch(200, { ok: true });
    await setMainModel(client(f), 'openrouter', 'anthropic/claude-opus-4.7', true);
    expect(JSON.parse(f.calls[0].init.body as string).confirm_expensive_model).toBe(true);
  });

  it('setMainModel surfaces the expensive-model guard (200 + ok:false)', async () => {
    const f = fakeFetch(200, {
      ok: false,
      confirm_required: true,
      confirm_message: 'This model is expensive. Continue?',
    });
    const res = await setMainModel(client(f), 'openrouter', 'pricey/model');
    expect(res.ok).toBe(false);
    expect(res.confirm_required).toBe(true);
    expect(res.confirm_message).toContain('expensive');
  });

  it('setMainModel surfaces server errors', async () => {
    const f = fakeFetch(500, { detail: 'Failed to save model assignment' });
    await expect(setMainModel(client(f), 'x', 'y')).rejects.toThrow('Failed to save model assignment');
  });
});

describe('modelDisplayName', () => {
  it('returns the trailing segment of namespaced ids', () => {
    expect(modelDisplayName('anthropic/claude-opus-4.7')).toBe('claude-opus-4.7');
  });
  it('passes bare ids through', () => {
    expect(modelDisplayName('Hermes-4-405B')).toBe('Hermes-4-405B');
  });
  it('handles empty ids', () => {
    expect(modelDisplayName('')).toBe('未配置');
  });
  it('does not return an empty tail for a trailing slash', () => {
    expect(modelDisplayName('weird/')).toBe('weird/');
  });
});

describe('pricingLine', () => {
  it('returns null when no pricing is present', () => {
    expect(pricingLine(undefined)).toBeNull();
  });
  it('labels free models', () => {
    expect(pricingLine({ input: '$0.00', output: '$0.00', cache: null, free: true })).toBe('免费');
  });
  it('joins input/output prices', () => {
    expect(pricingLine({ input: '$3.00', output: '$15.00', cache: '$0.30', free: false })).toBe(
      '输入 $3.00 · 输出 $15.00 / 百万词元',
    );
  });
  it('degrades when only one side is present', () => {
    expect(pricingLine({ input: '$3.00', output: '', cache: null, free: false })).toBe('输入 $3.00 / 百万词元');
    expect(pricingLine({ input: '', output: '', cache: null, free: false })).toBeNull();
  });
});

describe('hintBadges', () => {
  it('is empty without hints', () => {
    expect(hintBadges(undefined)).toEqual([]);
    expect(hintBadges({ fast: false, reasoning: false })).toEqual([]);
  });
  it('collects fast + reasoning', () => {
    expect(hintBadges({ fast: true, reasoning: true })).toEqual(['快速', '思考过程']);
    expect(hintBadges({ fast: true, reasoning: false })).toEqual(['快速']);
  });
});

describe('capabilityBadges', () => {
  it('is empty for {} or undefined', () => {
    expect(capabilityBadges({})).toEqual([]);
    expect(capabilityBadges(undefined)).toEqual([]);
  });
  it('orders reasoning, vision, tools', () => {
    expect(
      capabilityBadges({ supports_reasoning: true, supports_vision: true, supports_tools: true }),
    ).toEqual(['思考过程', '视觉', '工具']);
  });
});

describe('formatContext', () => {
  it('returns null for zero/invalid', () => {
    expect(formatContext(0)).toBeNull();
    expect(formatContext(NaN)).toBeNull();
    expect(formatContext(-1)).toBeNull();
  });
  it('formats thousands and millions, trimming .0', () => {
    expect(formatContext(200000)).toBe('200K 上下文');
    expect(formatContext(128000)).toBe('128K 上下文');
    expect(formatContext(1048576)).toBe('1M 上下文');
    expect(formatContext(1500000)).toBe('1.5M 上下文');
    expect(formatContext(512)).toBe('512 上下文');
  });
});

describe('isModel不可用', () => {
  const row: ProviderRow = {
    slug: 'nous',
    name: 'Nous',
    is_current: false,
    is_user_defined: false,
    models: ['Hermes-4-405B', 'Hermes-4-70B'],
    total_models: 2,
    source: 'built-in',
    authenticated: true,
    free_tier: true,
    unavailable_models: ['Hermes-4-405B'],
  };
  it('flags free-tier-blocked models', () => {
    expect(isModelUnavailable(row, 'Hermes-4-405B')).toBe(true);
    expect(isModelUnavailable(row, 'Hermes-4-70B')).toBe(false);
  });
  it('defaults false when the row has no unavailable list', () => {
    expect(isModelUnavailable({ ...row, unavailable_models: undefined }, 'Hermes-4-405B')).toBe(false);
  });
});
