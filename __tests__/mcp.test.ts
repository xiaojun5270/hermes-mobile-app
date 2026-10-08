// __tests__/mcp.test.ts
import {
  INSTALL_TIMEOUT_MS,
  McpAlreadyAddedError,
  McpPreflightError,
  OAUTH_START_TIMEOUT_MS,
  addMcpServer,
  cancelMcpOauthFlow,
  containsSecret,
  getMcpOauthFlow,
  installMcpCatalogEntry,
  listMcpCatalog,
  listMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  startMcpOauth,
  type McpServer,
} from '../src/api/mcp';
import { CookieJar } from '../src/api/cookieJar';
import { AuthError, HttpError, RestClient } from '../src/api/restClient';

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

function server(over: Partial<McpServer> = {}): McpServer {
  return {
    name: 'linear',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    command: null,
    args: [],
    env: {},
    auth: 'oauth',
    enabled: true,
    tools: null,
    source: 'config',
    plugin: null,
    ...over,
  };
}

const bodyOf = (f: ReturnType<typeof fakeFetch>, i = 0) => JSON.parse(f.calls[i].init.body as string);

describe('mcp api — servers', () => {
  it('listMcpServers unwraps {servers}', async () => {
    const f = fakeFetch(200, { servers: [server()] });
    const out = await listMcpServers(client(f));
    expect(f.calls[0].url).toBe('http://h/api/mcp/servers');
    expect(f.calls[0].init.method).toBeUndefined();
    expect(out).toEqual([server()]);
  });

  it('listMcpServers adds the profile only when one is selected', async () => {
    const f = fakeFetch(200, { servers: [] });
    await listMcpServers(client(f), 'work profile');
    await listMcpServers(client(f), null);
    expect(f.calls[0].url).toBe('http://h/api/mcp/servers?profile=work%20profile');
    expect(f.calls[1].url).toBe('http://h/api/mcp/servers');
  });

  it('addMcpServer posts the body and returns the summary', async () => {
    const f = fakeFetch(200, server({ name: 'mine', auth: null }));
    const out = await addMcpServer(client(f), { name: 'mine', url: 'https://x.example/mcp', auth: 'none' }, 'p');
    expect(f.calls[0].url).toBe('http://h/api/mcp/servers?profile=p');
    expect(f.calls[0].init.method).toBe('POST');
    expect(bodyOf(f)).toEqual({ name: 'mine', url: 'https://x.example/mcp', auth: 'none' });
    expect(out.name).toBe('mine');
  });

  it('addMcpServer sends a bearer token only in the body', async () => {
    const f = fakeFetch(200, server({ name: 'mine', auth: 'header' }));
    await addMcpServer(client(f), { name: 'mine', url: 'https://x.example/mcp', auth: 'header', bearer_token: 'tok-12345' });
    expect(bodyOf(f)).toEqual({ name: 'mine', url: 'https://x.example/mcp', auth: 'header', bearer_token: 'tok-12345' });
    expect(f.calls[0].url).not.toContain('tok-12345');
  });

  it('encodes server names in the path (review focus 2)', async () => {
    const f = fakeFetch(200, { ok: true, name: 'x', enabled: false });
    await setMcpServerEnabled(client(f), 'my server#1 é', false);
    await removeMcpServer(client(f), 'my server#1 é', 'p');
    expect(f.calls[0].url).toBe('http://h/api/mcp/servers/my%20server%231%20%C3%A9/enabled');
    expect(f.calls[0].init.method).toBe('PUT');
    expect(bodyOf(f)).toEqual({ enabled: false });
    expect(f.calls[1].url).toBe('http://h/api/mcp/servers/my%20server%231%20%C3%A9?profile=p');
    expect(f.calls[1].init.method).toBe('DELETE');
  });

  it('surfaces the gateway reason on a 409', async () => {
    const f = fakeFetch(409, { detail: "Server 'mine' already exists" });
    await expect(
      addMcpServer(client(f), { name: 'mine', url: 'https://x.example/mcp', auth: 'none' }),
    ).rejects.toThrow("Server 'mine' already exists");
  });
});

describe('mcp api — OAuth', () => {
  it('startMcpOauth sends a fast request first, then the slow POST', async () => {
    const f = fakeFetch(200, { servers: [], flow_id: 'f1', server_name: 'linear', status: 'authorization_required', authorization_url: 'https://a.example/authorize?state=s', error: null });
    const flow = await startMcpOauth(client(f), 'linear', 'p');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].url).toBe('http://h/api/mcp/servers?profile=p');
    expect(f.calls[0].init.method).toBeUndefined();
    expect(f.calls[1].url).toBe('http://h/api/mcp/servers/linear/auth?profile=p');
    expect(f.calls[1].init.method).toBe('POST');
    expect(flow.flow_id).toBe('f1');
  });

  it('startMcpOauth asks for the long limit on the POST only', async () => {
    const seen: (number | undefined)[] = [];
    const rest = {
      get: async (_p: string, o?: { timeoutMs?: number }) => {
        seen.push(o?.timeoutMs);
        return { servers: [] };
      },
      post: async (_p: string, _b?: unknown, o?: { timeoutMs?: number }) => {
        seen.push(o?.timeoutMs);
        return { flow_id: 'f1', server_name: 'x', status: 'starting', authorization_url: null, error: null };
      },
      put: async () => ({}),
      del: async () => ({}),
    };
    await startMcpOauth(rest as any, 'x');
    expect(seen).toEqual([undefined, OAUTH_START_TIMEOUT_MS]);
  });

  it('startMcpOauth does not start a flow when the fast request fails', async () => {
    const f = fakeFetch(401, {});
    await expect(startMcpOauth(client(f), 'linear')).rejects.toThrow(AuthError);
    expect(f.calls).toHaveLength(1);
  });

  it('a failure of the fast request is marked as such: no flow was started', async () => {
    const f = fakeFetch(404, { detail: "Profile 'x' not found" });
    const err = await startMcpOauth(client(f), 'linear', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(McpPreflightError);
    expect(err.reason).toBeInstanceOf(HttpError);
    expect(err.reason.message).toBe("Profile 'x' not found");
    expect(f.calls).toHaveLength(1);
  });

  it('a failure of the POST itself is passed through', async () => {
    const rest = {
      get: async () => ({ servers: [] }),
      post: async () => {
        throw new HttpError(409, "MCP OAuth for 'linear' is already in progress");
      },
      put: async () => ({}),
      del: async () => ({}),
    };
    const err = await startMcpOauth(rest as any, 'linear').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
  });

  it('flow status and cancel are keyed by flow id, with no profile', async () => {
    const f = fakeFetch(200, { ok: true, status: 'error', flow_id: 'a/b', server_name: 'x', authorization_url: null, error: null });
    await getMcpOauthFlow(client(f), 'a/b');
    const res = await cancelMcpOauthFlow(client(f), 'a/b');
    expect(f.calls[0].url).toBe('http://h/api/mcp/oauth/flows/a%2Fb');
    expect(f.calls[1].url).toBe('http://h/api/mcp/oauth/flows/a%2Fb');
    expect(f.calls[1].init.method).toBe('DELETE');
    expect(res.status).toBe('error');
  });
});

describe('mcp api — catalog', () => {
  it('listMcpCatalog returns entries and diagnostics', async () => {
    const f = fakeFetch(200, { entries: [], diagnostics: [] });
    const out = await listMcpCatalog(client(f), 'p');
    expect(f.calls[0].url).toBe('http://h/api/mcp/catalog?profile=p');
    expect(out).toEqual({ entries: [], diagnostics: [] });
  });

  /** A REST stub that records calls; `get`/`post` override what each answers (or throws). */
  function installRest(over: { get?: () => unknown; post?: () => unknown } = {}) {
    const calls: { verb: string; path: string; body?: unknown; opts?: { timeoutMs?: number } }[] = [];
    const rest = {
      get: async (path: string, opts?: { timeoutMs?: number }) => {
        calls.push({ verb: 'get', path, opts });
        return over.get ? over.get() : { servers: [] };
      },
      post: async (path: string, body?: unknown, opts?: { timeoutMs?: number }) => {
        calls.push({ verb: 'post', path, body, opts });
        return over.post ? over.post() : { ok: true, name: 'asana', background: false };
      },
      put: async () => ({}),
      del: async () => ({}),
    };
    return { rest: rest as any, calls };
  }

  it('install reads the server list first, then posts name, env and enable:true with the long limit', async () => {
    const { rest, calls } = installRest();
    const out = await installMcpCatalogEntry(rest, 'asana', { ASANA_CLIENT_ID: 'id-1' }, 'p');
    expect(calls).toEqual([
      { verb: 'get', path: '/api/mcp/servers?profile=p', opts: undefined },
      {
        verb: 'post',
        path: '/api/mcp/catalog/install?profile=p',
        body: { name: 'asana', env: { ASANA_CLIENT_ID: 'id-1' }, enable: true },
        opts: { timeoutMs: INSTALL_TIMEOUT_MS },
      },
    ]);
    expect(INSTALL_TIMEOUT_MS).toBe(45_000);
    expect(out.background).toBe(false);
  });

  it('install does not post when a connector of that name is already configured: the gateway would overwrite it', async () => {
    const { rest, calls } = installRest({ get: () => ({ servers: [{ name: 'asana' }] }) });
    await expect(installMcpCatalogEntry(rest, 'asana', {})).rejects.toBeInstanceOf(McpAlreadyAddedError);
    expect(calls.map((c) => c.verb)).toEqual(['get']);
  });

  it('install does not post when the fast request fails, and marks the failure as "nothing was sent"', async () => {
    const { rest, calls } = installRest({
      get: () => {
        throw new HttpError(0, 'request timed out after 20s');
      },
    });
    const err = await installMcpCatalogEntry(rest, 'asana', { A: 'secret-value-9' }).catch((e) => e);
    expect(err).toBeInstanceOf(McpPreflightError);
    expect(err.reason).toBeInstanceOf(HttpError);
    expect(calls.map((c) => c.verb)).toEqual(['get']);
  });

  it('a dead session on the fast request is an AuthError, not a preflight failure', async () => {
    const { rest } = installRest({
      get: () => {
        throw new AuthError('session expired');
      },
    });
    await expect(installMcpCatalogEntry(rest, 'asana', {})).rejects.toBeInstanceOf(AuthError);
  });
});

describe('mcp api — secret-safe errors', () => {
  const add = (f: ReturnType<typeof fakeFetch>, token: string) =>
    addMcpServer(client(f), { name: 'mine', url: 'https://x.example/mcp', auth: 'header', bearer_token: token });

  it('replaces a gateway message that echoes the token, and logs nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const f = fakeFetch(400, { detail: 'bad header value tok-12345 rejected' });
    const err = await add(f, 'tok-12345').catch((e) => e);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.message).not.toContain('tok-12345');
    expect(err.message).toBe('网关拒绝添加此连接器。');
  });

  it('catches the trimmed and Bearer-stripped forms (review focus 1)', async () => {
    const f = fakeFetch(400, { detail: 'value tok-12345 rejected' });
    const err = await add(f, '  Bearer tok-12345 ').catch((e) => e);
    expect(err.message).not.toContain('tok-12345');
  });

  it('keeps a gateway message that does not contain the token', async () => {
    const f = fakeFetch(409, { detail: "Server 'mine' already exists" });
    await expect(add(f, 'tok-12345')).rejects.toThrow("Server 'mine' already exists");
  });

  it('uses a status-specific message, with a generic fallback', async () => {
    const dup = await add(fakeFetch(409, { detail: 'tok-12345' }), 'tok-12345').catch((e) => e);
    expect(dup.message).toBe('已存在同名连接器。');
    const other = await add(fakeFetch(500, { detail: 'tok-12345' }), 'tok-12345').catch((e) => e);
    expect(other.message).toBe('网关返回错误（HTTP 500).');
  });

  it('cleans install errors that echo any env value', async () => {
    const rest = {
      get: async () => ({ servers: [] }),
      post: async () => {
        throw new HttpError(400, 'cannot write secret-value-9');
      },
      put: async () => ({}),
      del: async () => ({}),
    };
    const err = await installMcpCatalogEntry(rest as any, 'asana', { A: 'id-1', B: 'secret-value-9' }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('网关拒绝添加此连接器。');
  });

  it('cleans a non-HTTP error too', async () => {
    const rest = {
      get: async () => ({}),
      post: async () => {
        throw new Error('socket closed while sending tok-12345');
      },
      put: async () => ({}),
      del: async () => ({}),
    };
    const err = await addMcpServer(rest as any, { name: 'm', url: 'https://x', auth: 'header', bearer_token: 'tok-12345' }).catch((e) => e);
    expect(err.message).toBe('请求失败。');
  });

  it('passes AuthError through untouched', async () => {
    await expect(add(fakeFetch(401, {}), 'tok-12345')).rejects.toThrow(AuthError);
  });

  it('never forwards a rejection that is not an Error', async () => {
    const rest = {
      get: async () => ({}),
      post: async () => {
        throw { detail: 'echo tok-12345' };
      },
      put: async () => ({}),
      del: async () => ({}),
    };
    const err = await addMcpServer(rest as any, { name: 'm', url: 'https://x', auth: 'header', bearer_token: 'tok-12345' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('请求失败。');
    expect(JSON.stringify(err)).not.toContain('tok-12345');
  });

  it('drops anything else an HttpError carried', async () => {
    const rest = {
      get: async () => ({}),
      post: async () => {
        throw Object.assign(new HttpError(500, 'boom'), { cause: 'sent tok-12345' });
      },
      put: async () => ({}),
      del: async () => ({}),
    };
    const err = await addMcpServer(rest as any, { name: 'm', url: 'https://x', auth: 'header', bearer_token: 'tok-12345' }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('boom');
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it('containsSecret matches the trimmed and Bearer-stripped forms directly', () => {
    expect(containsSecret('got tok-12345', ['  tok-12345  '])).toBe(true);
    expect(containsSecret('got tok-12345', ['Bearer tok-12345'])).toBe(true);
    expect(containsSecret('got Bearer tok-12345', ['bearer   tok-12345'])).toBe(true);
  });

  it('containsSecret ignores values shorter than 4 characters', () => {
    expect(containsSecret('bad ab value', ['ab'])).toBe(false);
    expect(containsSecret('bad abcd value', ['abcd'])).toBe(true);
    expect(containsSecret('anything', [])).toBe(false);
    expect(containsSecret('x', ['   '])).toBe(false);
  });
});
