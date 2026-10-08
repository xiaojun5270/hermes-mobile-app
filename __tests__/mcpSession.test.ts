// __tests__/mcpSession.test.ts
import { RpcError } from '../src/api/gatewayClient';
import { mcpServerStatus, reloadMcp, testMcpServer } from '../src/api/mcpSession';

function recorder(result: unknown) {
  const calls: { method: string; params: unknown }[] = [];
  const call = async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (result instanceof Error) throw result;
    return result;
  };
  return { call: call as any, calls };
}

describe('testMcpServer', () => {
  it('calls mcp.servers.test with the name and maps a success', async () => {
    const r = recorder({
      ok: true,
      tools: [{ name: 'search', description: 'Search issues' }],
      prompts: 2,
      resources: 1,
      oauth_needed: true,
      oauth_tokens_present: true,
    });
    const out = await testMcpServer(r.call, 'linear');
    expect(r.calls).toEqual([{ method: 'mcp.servers.test', params: { name: 'linear' } }]);
    expect(out).toEqual({
      kind: 'ok',
      tools: [{ name: 'search', description: 'Search issues' }],
      prompts: 2,
      resources: 1,
      tokensPresent: true,
    });
  });

  it('adds the profile only when one is selected', async () => {
    const r = recorder({ ok: true, tools: [], oauth_needed: false });
    await testMcpServer(r.call, 'x', 'work');
    await testMcpServer(r.call, 'x', null);
    expect(r.calls[0].params).toEqual({ name: 'x', profile: 'work' });
    expect(r.calls[1].params).toEqual({ name: 'x' });
  });

  it('defaults missing counts to 0 and a missing token flag to null', async () => {
    const r = recorder({ ok: true, tools: [], oauth_needed: false });
    expect(await testMcpServer(r.call, 'x')).toEqual({ kind: 'ok', tools: [], prompts: 0, resources: 0, tokensPresent: null });
  });

  it('maps ok:false to failed with the gateway error and the token flag', async () => {
    const r = recorder({
      ok: false,
      tools: [],
      error: 'OAuth authentication required — no token found.',
      oauth_needed: true,
      oauth_tokens_present: false,
    });
    expect(await testMcpServer(r.call, 'x')).toEqual({
      kind: 'failed',
      message: 'OAuth authentication required — no token found.',
      oauthNeeded: true,
      tokensPresent: false,
    });
  });

  it('gives a failed test without error text a plain message', async () => {
    const r = recorder({ ok: false, tools: [], oauth_needed: false });
    const out = await testMcpServer(r.call, 'x');
    expect(out).toEqual({ kind: 'failed', message: '连接器未响应。', oauthNeeded: false, tokensPresent: null });
  });

  it('maps a rejected call to error instead of throwing', async () => {
    const r = recorder(new RpcError("server 'x' not found", 4064));
    expect(await testMcpServer(r.call, 'x')).toEqual({ kind: 'error', message: "server 'x' not found" });
  });
});

describe('mcpServerStatus', () => {
  const row = { name: 'linear', transport: 'http', tools: 12, connected: true, disabled: false, status: 'connected', source: 'config', plugin: null };

  it('returns the rows', async () => {
    const r = recorder({ servers: [row], checked_at: 1 });
    expect(await mcpServerStatus(r.call, 'work')).toEqual([row]);
    expect(r.calls).toEqual([{ method: 'mcp.servers.status', params: { profile: 'work' } }]);
  });

  it('sends no profile for the gateway default', async () => {
    const r = recorder({ servers: [], checked_at: 1 });
    await mcpServerStatus(r.call);
    expect(r.calls[0].params).toEqual({});
  });

  it('returns [] when the call fails', async () => {
    const r = recorder(new RpcError('socket closed', -1));
    expect(await mcpServerStatus(r.call)).toEqual([]);
  });
});

describe('reloadMcp', () => {
  it('always confirms, never sends `always`, and passes the live session id', async () => {
    const r = recorder({ status: 'reloaded' });
    expect(await reloadMcp(r.call, 's1')).toEqual({ kind: 'reloaded', thisChatOnly: false });
    expect(r.calls).toEqual([{ method: 'reload.mcp', params: { session_id: 's1', confirm: true } }]);
  });

  it('omits the session id for a chat that has none yet', async () => {
    const r = recorder({ status: 'reloaded' });
    await reloadMcp(r.call, null);
    await reloadMcp(r.call, '');
    expect(r.calls[0].params).toEqual({ confirm: true });
    expect(r.calls[1].params).toEqual({ confirm: true });
  });

  it('reports a compute-host reload as this chat only', async () => {
    const r = recorder({ status: 'reloaded', turn_isolation: true, host_ack: {} });
    expect(await reloadMcp(r.call, 's1')).toEqual({ kind: 'reloaded', thisChatOnly: true });
  });

  it('treats any other answer as a failure, with the gateway message when there is one', async () => {
    expect(await reloadMcp(recorder({ status: 'confirm_required', message: 'Reply now' }).call, 's1')).toEqual({
      kind: 'error',
      message: 'Reply now',
    });
    expect(await reloadMcp(recorder({ status: 'confirm_required' }).call, 's1')).toEqual({
      kind: 'error',
      message: '网关未重新加载。',
    });
  });

  it('a gateway error is a failure with its message', async () => {
    const r = recorder(new RpcError('compute-host reload_mcp failed: boom', 5019));
    expect(await reloadMcp(r.call, 's1')).toEqual({ kind: 'error', message: 'compute-host reload_mcp failed: boom' });
  });

  it('a call that never came back (socket closed, timeout) is unknown, not a failure', async () => {
    const r = recorder(new RpcError('socket closed', -1));
    expect(await reloadMcp(r.call, 's1')).toEqual({ kind: 'unknown' });
  });
});
