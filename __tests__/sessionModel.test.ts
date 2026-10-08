import { RpcError } from '../src/api/gatewayClient';
import { buildSessionModelValue, switchSessionModel, SESSION_BUSY_CODE } from '../src/api/sessionModel';

describe('buildSessionModelValue', () => {
  it('renders the model bare with --provider and --session', () => {
    expect(buildSessionModelValue('openrouter', 'glm-5.2')).toBe('glm-5.2 --provider openrouter --session');
  });
  it('passes a namespaced model id through unchanged', () => {
    expect(buildSessionModelValue('openai', 'openai/qwen3.7-max')).toBe(
      'openai/qwen3.7-max --provider openai --session',
    );
  });
});

describe('switchSessionModel', () => {
  const args = { sessionId: 's1', provider: 'openrouter', model: 'glm-5.2' };

  it('sends config.set with the built value and confirm flag, returns ok', async () => {
    const calls: any[] = [];
    const call = async (method: string, params: any) => {
      calls.push({ method, params });
      return { value: 'openrouter/glm-5.2' };
    };
    const out = await switchSessionModel(call as any, { ...args, confirmExpensive: true });
    expect(calls[0]).toEqual({
      method: 'config.set',
      params: {
        session_id: 's1',
        key: 'model',
        value: 'glm-5.2 --provider openrouter --session',
        confirm_expensive_model: true,
      },
    });
    expect(out).toEqual({ kind: 'ok', model: 'openrouter/glm-5.2' });
  });

  it('defaults confirm_expensive_model to false', async () => {
    let seen: any;
    const call = async (_m: string, params: any) => {
      seen = params;
      return {};
    };
    await switchSessionModel(call as any, args);
    expect(seen.confirm_expensive_model).toBe(false);
  });

  it('maps confirm_required to a confirm outcome (message → confirm_message)', async () => {
    const call = async () => ({ confirm_required: true, confirm_message: 'Pricey!' });
    expect(await switchSessionModel(call as any, args)).toEqual({ kind: 'confirm', message: 'Pricey!' });
  });

  it('confirm falls back to warning, then a default message', async () => {
    expect(await switchSessionModel((async () => ({ confirm_required: true, warning: 'W' })) as any, args)).toEqual({
      kind: 'confirm',
      message: 'W',
    });
    expect(await switchSessionModel((async () => ({ confirm_required: true })) as any, args)).toEqual({
      kind: 'confirm',
      message: '此模型费用可能较高，仍要切换吗？',
    });
  });

  it('maps an RPC 4009 rejection to busy', async () => {
    const call = async () => {
      throw new RpcError('session busy — /interrupt the current turn before switching models', SESSION_BUSY_CODE);
    };
    expect(await switchSessionModel(call as any, args)).toEqual({ kind: 'busy' });
  });

  it('maps a "session busy" message without a code to busy', async () => {
    const call = async () => {
      throw new Error('session busy — try later');
    };
    expect(await switchSessionModel(call as any, args)).toEqual({ kind: 'busy' });
  });

  it('maps a busy warning in a successful reply to busy', async () => {
    const call = async () => ({ warning: 'session busy — /interrupt the current turn before switching models' });
    expect(await switchSessionModel(call as any, args)).toEqual({ kind: 'busy' });
  });

  it('maps other rejections to error with the message', async () => {
    const call = async () => {
      throw new RpcError('unknown provider', 5001);
    };
    expect(await switchSessionModel(call as any, args)).toEqual({ kind: 'error', message: 'unknown provider' });
  });

  it('returns ok with null model when value is absent', async () => {
    expect(await switchSessionModel((async () => ({})) as any, args)).toEqual({ kind: 'ok', model: null });
  });

  it('4001 (stale live id) → resumeSession once → retries with the fresh id', async () => {
    const seen: string[] = [];
    const call = async (_m: string, params: any) => {
      seen.push(params.session_id);
      if (seen.length === 1) throw new RpcError('session not found', 4001);
      return { key: 'model', value: 'openrouter/glm-5.2' };
    };
    const resumeSession = jest.fn(async () => 's2');
    expect(await switchSessionModel(call as any, { ...args, resumeSession })).toEqual({ kind: 'ok', model: 'openrouter/glm-5.2' });
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['s1', 's2']);
  });

  it('a second 4001 surfaces as an error (retry once only)', async () => {
    const call = async () => {
      throw new RpcError('session not found', 4001);
    };
    const resumeSession = jest.fn(async () => 's2');
    expect(await switchSessionModel(call as any, { ...args, resumeSession })).toEqual({ kind: 'error', message: 'session not found' });
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it('without resumeSession a 4001 is a plain error', async () => {
    const call = async () => {
      throw new RpcError('session not found', 4001);
    };
    expect(await switchSessionModel(call as any, args)).toEqual({ kind: 'error', message: 'session not found' });
  });
});
