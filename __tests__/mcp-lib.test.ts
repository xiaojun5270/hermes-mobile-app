// __tests__/mcp-lib.test.ts
import { McpAlreadyAddedError, McpPreflightError, type McpCatalogEntry, type McpServer } from '../src/api/mcp';
import type { McpRuntimeRow } from '../src/api/mcpSession';
import { AuthError, HttpError } from '../src/api/restClient';
import {
  authLabel,
  catalogAuthLabel,
  checkAuthorizationUrl,
  collectSecretValues,
  connectorBadges,
  connectorError,
  filterCatalog,
  gatewaySupportsOauth,
  isCustomServerValid,
  isPlainEnvField,
  needsReload,
  remoteCatalogEntries,
  removeConfirmation,
  runtimeRowsByName,
  sameServerAddress,
  secretFieldsForEntry,
  serverCapabilities,
  serverSubtitle,
  signInLabel,
  statusLine,
  suggestServerName,
  testSummary,
  validateCustomServer,
} from '../src/lib/mcp';

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

function entry(over: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    name: 'linear',
    description: 'Issues and projects',
    connector_slug: 'linear',
    source: 'https://linear.app/docs/mcp',
    transport: 'http',
    auth_type: 'oauth',
    required_env: [],
    url: 'https://mcp.linear.app/mcp',
    needs_install: false,
    installed: false,
    enabled: false,
    ...over,
  };
}

function row(over: Partial<McpRuntimeRow> = {}): McpRuntimeRow {
  return { name: 'linear', transport: 'http', tools: 12, connected: true, disabled: false, status: 'connected', source: 'config', plugin: null, ...over };
}

describe('catalog', () => {
  it('keeps remote entries that need no install, sorted by name', () => {
    const out = remoteCatalogEntries([
      entry({ name: 'zapier' }),
      entry({ name: 'local', transport: 'stdio' }),
      entry({ name: 'builder', needs_install: true }),
      entry({ name: 'airtable' }),
    ]);
    expect(out.map((e) => e.name)).toEqual(['airtable', 'zapier']);
  });

  it('filters by name and description, case-insensitively', () => {
    const all = [entry({ name: 'linear', description: 'Issues' }), entry({ name: 'figma', description: 'Design FILES' })];
    expect(filterCatalog(all, 'files').map((e) => e.name)).toEqual(['figma']);
    expect(filterCatalog(all, ' LIN ').map((e) => e.name)).toEqual(['linear']);
    expect(filterCatalog(all, '')).toHaveLength(2);
  });

  it('tolerates entries with missing optional fields (review focus 5)', () => {
    const bare = { name: 'bare', transport: 'http', needs_install: false } as unknown as McpCatalogEntry;
    expect(remoteCatalogEntries([bare])).toHaveLength(1);
    expect(filterCatalog([bare], 'zzz')).toEqual([]);
    expect(filterCatalog([bare], 'bar')).toHaveLength(1);
  });
});

describe('suggestServerName', () => {
  it.each([
    ['https://mcp.linear.app/mcp', 'linear'],
    ['https://gws.mcp.gldc.io', 'gws'],
    ['https://example.com/x', 'example'],
    ['https://api.githubcopilot.com/mcp/', 'githubcopilot'],
    ['http://localhost:3000', 'localhost'],
    ['http://100.89.28.11:8080', ''],
    ['not a url', ''],
    ['', ''],
  ])('%s → %s', (url, name) => {
    expect(suggestServerName(url)).toBe(name);
  });
});

describe('validateCustomServer', () => {
  const ok = { name: 'mine', url: 'https://x.example/mcp', auth: 'none' as const, hasToken: false };

  it('accepts a complete draft', () => {
    const issues = validateCustomServer(ok);
    expect(issues).toEqual({});
    expect(isCustomServerValid(issues)).toBe(true);
  });

  it('requires a name without spaces or slashes', () => {
    expect(validateCustomServer({ ...ok, name: '  ' }).name).toBe('请输入名称。');
    expect(validateCustomServer({ ...ok, name: 'my server' }).name).toBe('名称不能包含空格或斜杠。');
    expect(validateCustomServer({ ...ok, name: 'a/b' }).name).toBe('名称不能包含空格或斜杠。');
  });

  it('requires an http or https URL', () => {
    expect(validateCustomServer({ ...ok, url: '' }).url).toBe('请输入服务器地址。');
    expect(validateCustomServer({ ...ok, url: 'ftp://x.example' }).url).toBe('请输入以 https:// 开头的地址。');
    expect(validateCustomServer({ ...ok, url: 'x.example/mcp' }).url).toBe('请输入以 https:// 开头的地址。');
  });

  it('cautions on http but still allows it', () => {
    const issues = validateCustomServer({ ...ok, url: 'http://10.0.0.5:8000/mcp' });
    expect(issues.url).toBeUndefined();
    expect(issues.caution).toBe('网关与此服务器之间的通信不会加密。');
    expect(isCustomServerValid(issues)).toBe(true);
  });

  it('requires a token for bearer auth only', () => {
    expect(validateCustomServer({ ...ok, auth: 'header', hasToken: false }).token).toBe('请输入令牌。');
    expect(validateCustomServer({ ...ok, auth: 'header', hasToken: true }).token).toBeUndefined();
    expect(validateCustomServer({ ...ok, auth: 'oauth', hasToken: false }).token).toBeUndefined();
  });
});

describe('serverCapabilities (spec §5.3)', () => {
  it('remote config server with OAuth: everything', () => {
    expect(serverCapabilities(server())).toEqual({ manageable: true, canSwitch: true, canTest: true, autoTest: true, canSignIn: true, canRemove: true });
  });
  it('remote config server without OAuth cannot sign in', () => {
    expect(serverCapabilities(server({ auth: 'header' })).canSignIn).toBe(false);
    expect(serverCapabilities(server({ auth: null })).canSignIn).toBe(false);
  });
  it('stdio config server: switch and on-demand test only', () => {
    expect(serverCapabilities(server({ transport: 'stdio', url: null, command: 'uvx', auth: null }))).toEqual({
      manageable: true, canSwitch: true, canTest: true, autoTest: false, canSignIn: false, canRemove: false,
    });
  });
  it('plugin server: test only', () => {
    expect(serverCapabilities(server({ source: 'plugin', plugin: 'p' }))).toEqual({
      manageable: true, canSwitch: false, canTest: true, autoTest: true, canSignIn: false, canRemove: false,
    });
  });
  it('plugin stdio server: on-demand test only', () => {
    expect(
      serverCapabilities(server({ source: 'plugin', plugin: 'p', transport: 'stdio', url: null, command: 'uvx', auth: null })),
    ).toEqual({ manageable: true, canSwitch: false, canTest: true, autoTest: false, canSignIn: false, canRemove: false });
  });
  it('unknown transport: switch only', () => {
    expect(serverCapabilities(server({ transport: 'unknown', url: null, auth: null }))).toEqual({
      manageable: true, canSwitch: true, canTest: false, autoTest: false, canSignIn: false, canRemove: false,
    });
  });
  it('a name with a slash cannot be managed over REST', () => {
    expect(serverCapabilities(server({ name: 'a/b' }))).toEqual({
      manageable: false, canSwitch: false, canTest: true, autoTest: true, canSignIn: false, canRemove: false,
    });
  });
});

describe('labels', () => {
  it('authLabel', () => {
    expect(authLabel(server({ auth: 'oauth' }))).toBe('OAuth');
    expect(authLabel(server({ auth: 'header' }))).toBe('令牌');
    expect(authLabel(server({ auth: null }))).toBeNull();
    expect(authLabel(server({ auth: 'none' }))).toBeNull();
  });

  it('serverSubtitle shows the host, the command, or nothing', () => {
    expect(serverSubtitle(server())).toBe('mcp.linear.app');
    expect(serverSubtitle(server({ url: 'not a url' }))).toBe('not a url');
    expect(serverSubtitle(server({ transport: 'stdio', url: null, command: 'uvx', args: ['a', 'b'] }))).toBe('uvx a b');
    expect(serverSubtitle(server({ transport: 'unknown', url: null, command: null }))).toBe('');
  });

  it('isPlainEnvField unmasks only URL, HOST and ID names', () => {
    expect(isPlainEnvField('N8N_MCP_SERVER_URL')).toBe(true);
    expect(isPlainEnvField('db_host')).toBe(true);
    expect(isPlainEnvField('ASANA_CLIENT_ID')).toBe(true);
    expect(isPlainEnvField('ASANA_CLIENT_SECRET')).toBe(false);
    expect(isPlainEnvField('GITHUB_PAT')).toBe(false);
    expect(isPlainEnvField('URL_SIGNING_KEY')).toBe(false);
  });
});

describe('statusLine (spec §5.8)', () => {
  it('has no line without a runtime row', () => {
    expect(statusLine(server())).toBeNull();
  });
  it.each([
    [row({ status: 'connected', tools: 12 }), '已连接 · 12 个工具'],
    [row({ status: 'connected', tools: 1 }), '已连接 · 1 个工具'],
    [row({ status: 'lazy', tools: 3 }), '就绪 · 3 个工具'],
    [row({ status: 'connecting' }), '正在连接…'],
    [row({ status: 'failed' }), '失败'],
  ])('enabled server: %#', (r, line) => {
    expect(statusLine(server(), r)).toBe(line);
  });
  it('marks a mismatch between the switch and the running gateway', () => {
    expect(statusLine(server({ enabled: false }), row({ status: 'connected', tools: 2 }))).toBe('已连接 · 2 个工具 · 重新加载后生效');
    expect(statusLine(server({ enabled: false }), row({ status: 'lazy', tools: 2 }))).toBe('就绪 · 2 个工具 · 重新加载后生效');
    expect(statusLine(server({ enabled: true }), row({ status: 'disabled' }))).toBe('已关闭 · 重新加载后生效');
    expect(statusLine(server({ enabled: true }), row({ status: 'configured' }))).toBe('尚未加载 · 重新加载后生效');
  });
  it('has no suffix when they agree', () => {
    expect(statusLine(server({ enabled: false }), row({ status: 'disabled' }))).toBe('已关闭');
    expect(statusLine(server({ enabled: false }), row({ status: 'configured' }))).toBe('尚未加载');
  });
  it('tolerates a missing tool count and an unknown status (review focus 5)', () => {
    expect(statusLine(server(), { ...row(), tools: undefined } as unknown as McpRuntimeRow)).toBe('已连接 · 0 个工具');
    expect(statusLine(server(), { ...row(), status: 'new-state' } as unknown as McpRuntimeRow)).toBeNull();
  });
});

describe('connectorError (spec §8)', () => {
  it('AuthError → auth', () => {
    expect(connectorError(new AuthError('x'), 'list')).toEqual({ kind: 'auth' });
  });
  it('a bare 404 on the list or catalog means an unsupported gateway', () => {
    const msg = '此网关不支持连接器，需要 Hermes 0.21.5 或更新版本。';
    expect(connectorError(new HttpError(404, 'Not Found'), 'list')).toEqual({ kind: 'unsupported', message: msg });
    expect(connectorError(new HttpError(404, 'HTTP 404 on /api/mcp/catalog'), 'catalog')).toEqual({ kind: 'unsupported', message: msg });
  });
  it('a 404 with a reason on the list is shown as the reason', () => {
    expect(connectorError(new HttpError(404, "Profile 'x' not found"), 'list')).toEqual({ kind: 'message', message: "Profile 'x' not found" });
  });
  it('a non-JSON answer on the list means an unsupported gateway', () => {
    expect(connectorError(new SyntaxError('Unexpected token <'), 'list').kind).toBe('unsupported');
  });
  it('a 404 on a server action means the connector is gone', () => {
    for (const action of ['switch', 'remove', 'signin'] as const) {
      expect(connectorError(new HttpError(404, "Server 'x' not found"), action)).toEqual({ kind: 'gone', message: '此连接器已不存在。' });
    }
  });
  it('a 404 on install is the gateway reason', () => {
    expect(connectorError(new HttpError(404, "No catalog entry 'x'"), 'install')).toEqual({ kind: 'message', message: "No catalog entry 'x'" });
  });
  it('a timeout on a write says to check the list first', () => {
    expect(connectorError(new HttpError(0, 'request timed out after 20s'), 'add')).toEqual({
      kind: 'message',
      message: '网关响应超时。 请先检查列表再重试。',
    });
    expect(connectorError(new HttpError(0, 'request timed out after 20s'), 'list')).toEqual({
      kind: 'message',
      message: '网关响应超时。',
    });
  });
  it('other HTTP errors show the gateway reason', () => {
    expect(connectorError(new HttpError(409, "Server 'x' already exists"), 'add')).toEqual({ kind: 'message', message: "Server 'x' already exists" });
    expect(connectorError(new HttpError(429, 'rate limited — wait a minute'), 'signin')).toEqual({ kind: 'message', message: 'rate limited — wait a minute' });
  });
  it('replaces a status-only message with plain words', () => {
    expect(connectorError(new HttpError(422, 'HTTP 422 on /api/mcp/servers?profile=p'), 'add')).toEqual({
      kind: 'message',
      message: '网关无法读取此请求。',
    });
    expect(connectorError(new HttpError(500, 'HTTP 500 on /api/mcp/servers'), 'switch')).toEqual({
      kind: 'message',
      message: '网关返回错误（HTTP 500).',
    });
  });
  it('also classifies localized REST fallbacks without changing server-supplied reasons', () => {
    expect(connectorError(new HttpError(404, '请求 /api/mcp/catalog 失败（HTTP 404）'), 'catalog').kind).toBe('unsupported');
    expect(connectorError(new HttpError(422, '请求 /api/mcp/servers 失败（HTTP 422）'), 'add')).toEqual({
      kind: 'message', message: '网关无法读取此请求。',
    });
    const reason = 'OAuth authentication required — no token found.';
    expect(connectorError(new HttpError(403, reason), 'signin')).toEqual({ kind: 'message', message: reason });
  });
  it('anything else is a network failure', () => {
    expect(connectorError(new TypeError('Network request failed'), 'switch')).toEqual({
      kind: 'message',
      message: '无法连接网关，请检查 VPN 或 Wi-Fi。',
    });
    expect(connectorError('boom', 'list').kind).toBe('message');
  });
});

describe('checkAuthorizationUrl (rule B, spec §5.6)', () => {
  const base = 'https://hermes.kite-opah.ts.net';
  const cb = encodeURIComponent('https://hermes.kite-opah.ts.net/api/mcp/oauth/callback/linear');

  it('accepts an https URL whose redirect comes back to the gateway', () => {
    expect(checkAuthorizationUrl(`https://linear.app/oauth/authorize?state=s&redirect_uri=${cb}`, base)).toBeNull();
  });
  it('accepts a gateway URL written with a trailing slash or other case', () => {
    expect(checkAuthorizationUrl(`https://a.example/authorize?redirect_uri=${cb}`, 'https://Hermes.Kite-Opah.ts.net/')).toBeNull();
  });
  it('accepts an https URL with no redirect_uri (pushed authorization request)', () => {
    expect(checkAuthorizationUrl('https://a.example/authorize?request_uri=urn%3Ax&client_id=c', base)).toBeNull();
  });
  it('refuses a URL that is not https', () => {
    expect(checkAuthorizationUrl(`http://a.example/authorize?redirect_uri=${cb}`, base)).toBe(
      '登录地址未使用 HTTPS，已阻止打开。',
    );
    expect(checkAuthorizationUrl('tel:+15551234', base)).toBe('登录地址未使用 HTTPS，已阻止打开。');
  });
  it('refuses a URL that does not parse', () => {
    expect(checkAuthorizationUrl('::::', base)).toBe('网关返回了无效的登录地址。');
  });
  it('refuses a redirect to another host, another path, or plain http', () => {
    const elsewhere = encodeURIComponent('http://127.0.0.1:9119/api/mcp/oauth/callback/linear');
    const wrongPath = encodeURIComponent('https://hermes.kite-opah.ts.net/other/linear');
    const msg =
      '网关的登录回调地址无法由此手机访问，请将网关的 HERMES_DASHBOARD_PUBLIC_URL 设置为 https://hermes.kite-opah.ts.net.';
    expect(checkAuthorizationUrl(`https://a.example/authorize?redirect_uri=${elsewhere}`, base)).toBe(msg);
    expect(checkAuthorizationUrl(`https://a.example/authorize?redirect_uri=${wrongPath}`, base)).toBe(msg);
    expect(checkAuthorizationUrl('https://a.example/authorize?redirect_uri=nonsense', base)).toBe(msg);
  });
  it('refuses when any of several redirect_uri values points elsewhere', () => {
    const evil = encodeURIComponent('https://evil.example/api/mcp/oauth/callback/linear');
    expect(checkAuthorizationUrl(`https://a.example/authorize?redirect_uri=${cb}&redirect_uri=${evil}`, base)).not.toBeNull();
  });
  it('does not echo credentials from the gateway URL, and keeps a path prefix', () => {
    const msg = checkAuthorizationUrl('https://a.example/authorize?redirect_uri=nonsense', 'https://user:pw@h.example/Hermes/');
    expect(msg).toContain('设置为 https://h.example/Hermes.');
    expect(msg).not.toContain('pw');
  });
  it('accepts a redirect under a gateway path prefix', () => {
    const prefixed = encodeURIComponent('https://h.example/hermes/api/mcp/oauth/callback/linear');
    expect(checkAuthorizationUrl(`https://a.example/authorize?redirect_uri=${prefixed}`, 'https://h.example/hermes')).toBeNull();
  });
  it('reports a gateway URL that does not parse', () => {
    expect(checkAuthorizationUrl('https://a.example/authorize?redirect_uri=x', 'nope')).toBe(
      '应用中配置的网关地址无效。',
    );
  });
  it('gatewaySupportsOauth needs an https gateway URL', () => {
    expect(gatewaySupportsOauth('https://hermes.kite-opah.ts.net')).toBe(true);
    expect(gatewaySupportsOauth('HTTPS://h')).toBe(true);
    expect(gatewaySupportsOauth('http://100.89.28.11:9119')).toBe(false);
  });
});

describe('runtimeRowsByName (spec §5.8)', () => {
  it('indexes rows by server name', () => {
    const map = runtimeRowsByName([row({ name: 'a' }), row({ name: 'b', status: 'failed' })], false);
    expect([...map.keys()]).toEqual(['a', 'b']);
    expect(map.get('b')?.status).toBe('failed');
  });

  it('keeps every row for the gateway default profile, even when nothing is loaded', () => {
    const map = runtimeRowsByName([row({ name: 'a', status: 'configured' })], false);
    expect(map.size).toBe(1);
  });

  it('hides all rows for a selected profile when the gateway reports no runtime state (review focus 2)', () => {
    const rows = [row({ name: 'a', status: 'configured' }), row({ name: 'b', status: 'disabled' })];
    expect(runtimeRowsByName(rows, true).size).toBe(0);
  });

  it('keeps rows for a selected profile once any row shows runtime state', () => {
    const rows = [row({ name: 'a', status: 'configured' }), row({ name: 'b', status: 'failed' })];
    expect(runtimeRowsByName(rows, true).size).toBe(2);
  });

  it('tolerates an empty or missing list (review focus 1)', () => {
    expect(runtimeRowsByName([], false).size).toBe(0);
    expect(runtimeRowsByName(undefined as unknown as McpRuntimeRow[], true).size).toBe(0);
  });
});

describe('connectorBadges', () => {
  it('lists auth, Local and Plugin in that order', () => {
    expect(connectorBadges(server())).toEqual(['OAuth']);
    expect(connectorBadges(server({ auth: 'header' }))).toEqual(['令牌']);
    expect(connectorBadges(server({ auth: null }))).toEqual([]);
    expect(connectorBadges(server({ transport: 'stdio', url: null, command: 'uvx', auth: null }))).toEqual(['本地']);
    expect(connectorBadges(server({ source: 'plugin', plugin: 'p' }))).toEqual(['OAuth', '插件']);
  });
});

describe('testSummary', () => {
  it('counts tools, and 个提示词 and 个资源 only when there are any', () => {
    expect(testSummary({ tools: [1, 2, 3], prompts: 0, resources: 0 })).toBe('连接正常 · 3 个工具');
    expect(testSummary({ tools: [1], prompts: 2, resources: 1 })).toBe('连接正常 · 1 个工具 · 2 个提示词 · 1 个资源');
    expect(testSummary({ tools: [], prompts: 1, resources: 0 })).toBe('连接正常 · 0 个工具 · 1 个提示词');
  });
});

describe('needsReload', () => {
  it('is true when the switch and the running gateway disagree', () => {
    expect(needsReload(server({ enabled: true }), row({ status: 'configured' }))).toBe(true);
    expect(needsReload(server({ enabled: true }), row({ status: 'disabled' }))).toBe(true);
    expect(needsReload(server({ enabled: false }), row({ status: 'connected' }))).toBe(true);
    expect(needsReload(server({ enabled: false }), row({ status: 'lazy' }))).toBe(true);
  });
  it('is false when they agree, while connecting or failed, and without a row', () => {
    expect(needsReload(server({ enabled: true }), row({ status: 'connected' }))).toBe(false);
    expect(needsReload(server({ enabled: false }), row({ status: 'disabled' }))).toBe(false);
    expect(needsReload(server({ enabled: false }), row({ status: 'configured' }))).toBe(false);
    expect(needsReload(server({ enabled: true }), row({ status: 'connecting' }))).toBe(false);
    expect(needsReload(server({ enabled: true }), row({ status: 'failed' }))).toBe(false);
    expect(needsReload(server())).toBe(false);
  });
});

describe('connectorError — a slow request that was never sent', () => {
  it('a failed fast request is about reaching the gateway: no "check the list", nothing was sent', () => {
    expect(connectorError(new McpPreflightError(new HttpError(0, 'request timed out after 20s')), 'install')).toEqual({
      kind: 'message',
      message: '网关响应超时。',
    });
    expect(connectorError(new McpPreflightError(new TypeError('Network request failed')), 'add')).toEqual({
      kind: 'message',
      message: '无法连接网关，请检查 VPN 或 Wi-Fi。',
    });
  });
  it('a bare 404 on the fast request means an unsupported gateway', () => {
    expect(connectorError(new McpPreflightError(new HttpError(404, 'Not Found')), 'install').kind).toBe('unsupported');
  });
  it('an entry that is already configured says so', () => {
    expect(connectorError(new McpAlreadyAddedError('asana'), 'install')).toEqual({
      kind: 'message',
      message: '此连接器已添加。',
    });
  });
});

describe('helpers for the add forms', () => {
  const env = (name: string, prompt = '', required = true) => ({ name, prompt, required });

  it('secretFieldsForEntry: one field per declared variable, masked unless the name is plain', () => {
    const fields = secretFieldsForEntry(
      entry({
        required_env: [env('ASANA_CLIENT_SECRET', 'Asana client secret'), env('N8N_MCP_SERVER_URL', '  ', false), env('GITHUB_PAT')],
      }),
    );
    expect(fields).toEqual([
      { key: 'ASANA_CLIENT_SECRET', label: 'Asana client secret', masked: true, required: true },
      { key: 'N8N_MCP_SERVER_URL', label: 'N8N_MCP_SERVER_URL', masked: false, required: false },
      { key: 'GITHUB_PAT', label: 'GITHUB_PAT', masked: true, required: true },
    ]);
  });

  it('secretFieldsForEntry tolerates a missing list', () => {
    expect(secretFieldsForEntry({ name: 'x' } as unknown as McpCatalogEntry)).toEqual([]);
    expect(secretFieldsForEntry(entry())).toEqual([]);
  });

  it('collectSecretValues trims, leaves blanks out, and names the first required field left blank', () => {
    const fields = [
      { key: 'A', label: 'First', masked: true, required: true },
      { key: 'B', label: 'Second', masked: true, required: true },
      { key: 'C', label: 'Third', masked: false, required: false },
    ];
    expect(collectSecretValues(fields, { A: '  one ', B: 'two', C: '   ' })).toEqual({ env: { A: 'one', B: 'two' }, missing: null });
    expect(collectSecretValues(fields, { A: 'one' }).missing).toEqual(fields[1]);
    expect(collectSecretValues(fields, {}).missing).toEqual(fields[0]);
    expect(collectSecretValues([], { stray: 'x' })).toEqual({ env: {}, missing: null });
  });

  it('catalogAuthLabel', () => {
    expect(catalogAuthLabel(entry({ auth_type: 'oauth' }))).toBe('OAuth 登录');
    expect(catalogAuthLabel(entry({ auth_type: 'none' }))).toBe('无需登录');
    expect(catalogAuthLabel(entry({ auth_type: '' }))).toBe('无需登录');
    expect(catalogAuthLabel(entry({ auth_type: 'api_key' }))).toBe('api_key');
  });

  it('signInLabel says "again" only when the last test saw a token', () => {
    expect(signInLabel(null)).toBe('登录');
    expect(signInLabel({ kind: 'error', message: 'x' })).toBe('登录');
    expect(signInLabel({ kind: 'ok', tools: [], prompts: 0, resources: 0, tokensPresent: null })).toBe('登录');
    expect(signInLabel({ kind: 'ok', tools: [], prompts: 0, resources: 0, tokensPresent: true })).toBe('重新登录');
    expect(signInLabel({ kind: 'failed', message: 'x', oauthNeeded: true, tokensPresent: true })).toBe('重新登录');
    expect(signInLabel({ kind: 'failed', message: 'x', oauthNeeded: true, tokensPresent: false })).toBe('登录');
  });

  it('removeConfirmation says what stays on the gateway', () => {
    const c = removeConfirmation('linear');
    expect(c.title).toBe('移除 linear?');
    expect(c.message).toBe(
      '重新加载或重启网关后，智能体将停止使用此连接器。登录信息和令牌仍保留在网关，需在网关上另行删除。',
    );
  });

  it('sameServerAddress compares the submitted URL with the one the gateway has', () => {
    expect(sameServerAddress(server({ url: 'https://x.example/mcp' }), ' https://x.example/mcp ')).toBe(true);
    expect(sameServerAddress(server({ url: 'https://x.example/mcp' }), 'https://y.example/mcp')).toBe(false);
    expect(sameServerAddress(server({ url: null }), 'https://x.example/mcp')).toBe(false);
  });
});

describe('validateCustomServer — a URL that carries a secret', () => {
  const base = { name: 'mine', auth: 'none' as const, hasToken: false };
  it('cautions on a query string or on credentials in the URL, without blocking', () => {
    const q = validateCustomServer({ ...base, url: 'https://x.example/mcp?api_key=abc' });
    expect(q.url).toBeUndefined();
    expect(q.caution).toBe('此地址包含密钥或凭据，将原样保存在网关并显示在应用中。');
    expect(validateCustomServer({ ...base, url: 'https://user:pw@x.example/mcp' }).caution).toMatch(/包含密钥或凭据/);
  });
  it('gives both cautions for an http URL with a key', () => {
    const both = validateCustomServer({ ...base, url: 'http://x.example/mcp?key=1' }).caution ?? '';
    expect(both).toMatch(/不会加密/);
    expect(both).toMatch(/包含密钥或凭据/);
  });
  it('has no caution for a plain https URL', () => {
    expect(validateCustomServer({ ...base, url: 'https://x.example/mcp' }).caution).toBeUndefined();
  });
});
