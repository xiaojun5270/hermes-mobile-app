// The add flow: catalog → entry → install, and the custom server form. The REST layer, Face ID
// and the sign-in hook are mocked; the screens, the secret form and the stores are real.
import { Stack, router } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Text } from 'react-native';
import { McpAlreadyAddedError, McpPreflightError, type McpCatalogEntry, type McpServer } from '../src/api/mcp';
import { AuthError, HttpError } from '../src/api/restClient';
import ConnectorsScreen from '../src/app/connectors';
import AddConnectorScreen from '../src/app/connectors/add';
import CatalogEntryScreen from '../src/app/connectors/catalog/[name]';
import CustomConnectorScreen from '../src/app/connectors/custom';
import ConnectorDetailScreen from '../src/app/connectors/server/[name]';
import { __resetSessionMcpStore, getMcpChangePending } from '../src/session-mcp-store';

jest.mock('../src/components/icon', () => ({ Icon: () => null }));

let mockBaseUrl = 'https://hermes.example.ts.net';
jest.mock('../src/connection', () => ({
  withAuthRetry: (fn: (r: unknown) => Promise<unknown>) => fn({}),
  getRest: () => ({ baseUrl: mockBaseUrl }),
}));

const mockList = jest.fn();
const mockCatalog = jest.fn();
const mockInstall = jest.fn();
const mockAdd = jest.fn();
jest.mock('../src/api/mcp', () => ({
  ...jest.requireActual('../src/api/mcp'),
  listMcpServers: (...a: unknown[]) => mockList(...a),
  listMcpCatalog: (...a: unknown[]) => mockCatalog(...a),
  installMcpCatalogEntry: (...a: unknown[]) => mockInstall(...a),
  addMcpServer: (...a: unknown[]) => mockAdd(...a),
  setMcpServerEnabled: jest.fn(),
  removeMcpServer: jest.fn(),
}));

const mockAuthenticate = jest.fn();
jest.mock('../src/lib/biometric', () => ({
  confirmWithBiometrics: (...a: unknown[]) => mockAuthenticate(...a),
}));

const mockRequestSignIn = jest.fn();
jest.mock('../src/components/connector-sign-in', () => ({
  ...jest.requireActual('../src/components/connector-sign-in'),
  useConnectorSignIn: () => ({ phase: null, cancelling: false, signIn: jest.fn(), cancel: jest.fn() }),
  consumeSignInRequest: () => false,
  dropSignInRequest: () => {},
  requestSignInOnOpen: (name: string) => mockRequestSignIn(name),
}));

function entry(over: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    name: 'linear',
    description: 'Issues and projects from Linear.',
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

const DOCS = entry({ name: 'docs', description: 'Public documentation search.', auth_type: 'none', url: 'https://docs.example/mcp' });
const ASANA = entry({
  name: 'asana',
  description: 'Tasks from Asana.',
  url: 'https://mcp.asana.com/sse',
  required_env: [
    { name: 'ASANA_CLIENT_ID', prompt: 'Asana client ID', required: true },
    { name: 'ASANA_CLIENT_SECRET', prompt: 'Asana client secret', required: true },
  ],
});
const SECRET = 'cs-7f31-very-secret';

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

let pathname: () => string;
/** The path with its query: what a route param would show up in. */
let fullPath: () => string;

async function open(...urls: string[]) {
  const rendered = renderRouter(
    {
      _layout: () => <Stack />,
      index: () => <Text>sign in</Text>,
      connectors: ConnectorsScreen,
      'connectors/add': AddConnectorScreen,
      'connectors/catalog/[name]': CatalogEntryScreen,
      'connectors/custom': CustomConnectorScreen,
      'connectors/server/[name]': ConnectorDetailScreen,
      'chat/[id]': () => <Text>a chat</Text>,
    },
    { initialUrl: '/' },
  );
  pathname = () => rendered.getPathname();
  fullPath = () => rendered.getPathnameWithParams();
  await rendered;
  for (const url of urls) {
    await act(async () => router.push(url as never));
    await flush();
  }
}

const pressAdd = () =>
  act(async () => {
    await fireEvent.press(screen.getByRole('button', { name: '添加连接器' }));
  });

beforeEach(() => {
  __resetSessionMcpStore();
  mockBaseUrl = 'https://hermes.example.ts.net';
  for (const m of [mockList, mockCatalog, mockInstall, mockAdd, mockAuthenticate, mockRequestSignIn]) m.mockReset();
  mockList.mockResolvedValue([]);
  mockCatalog.mockResolvedValue({
    entries: [entry(), DOCS, ASANA, entry({ name: 'local-thing', transport: 'stdio' }), entry({ name: 'builder', needs_install: true })],
    diagnostics: [],
  });
  mockAuthenticate.mockResolvedValue({ ok: true });
});

describe('Catalog', () => {
  it('lists the remote entries that need no install, with how each signs in, and the 自定义服务器 row', async () => {
    await open('/connectors', '/connectors/add');
    expect(screen.getByText('asana')).toBeTruthy();
    expect(screen.getByText('docs')).toBeTruthy();
    expect(screen.getByText('linear')).toBeTruthy();
    expect(screen.queryByText('local-thing')).toBeNull();
    expect(screen.queryByText('builder')).toBeNull();
    expect(screen.getByText('无需登录')).toBeTruthy();
    expect(screen.getByRole('button', { name: '自定义服务器，通过地址添加' })).toBeTruthy();
  });

  it('an entry opens its page; the Custom row opens the form', async () => {
    await open('/connectors', '/connectors/add');
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: /^docs,/ }));
    });
    await flush();
    expect(pathname()).toBe('/connectors/catalog/docs');
    await act(async () => router.back());
    await flush();
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: '自定义服务器，通过地址添加' }));
    });
    await flush();
    expect(pathname()).toBe('/connectors/custom');
  });

  it('an entry that is already added says so and opens its connector', async () => {
    mockCatalog.mockResolvedValue({ entries: [entry({ installed: true })], diagnostics: [] });
    mockList.mockResolvedValue([server()]);
    await open('/connectors', '/connectors/add');
    expect(screen.getByText('已添加')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: /^linear,/ }));
    });
    await flush();
    expect(pathname()).toBe('/connectors/server/linear');
  });

  it('an empty catalog says so and still offers the Custom row', async () => {
    mockCatalog.mockResolvedValue({ entries: [], diagnostics: [] });
    await open('/connectors', '/connectors/add');
    expect(screen.getByText('目录中暂无连接器')).toBeTruthy();
    expect(screen.getByRole('button', { name: '自定义服务器，通过地址添加' })).toBeTruthy();
  });

  it('a catalog that fails to load shows why and still offers the Custom row', async () => {
    mockCatalog.mockRejectedValue(new TypeError('Network request failed'));
    await open('/connectors', '/connectors/add');
    expect(screen.getByText('无法连接网关，请检查 VPN 或 Wi-Fi。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '自定义服务器，通过地址添加' })).toBeTruthy();
  });

  it('a gateway without the catalog route says connectors are not available', async () => {
    mockCatalog.mockRejectedValue(new HttpError(404, 'Not Found'));
    await open('/connectors', '/connectors/add');
    expect(screen.getByText('此网关不支持连接器，需要 Hermes 0.21.5 或更新版本。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '自定义服务器，通过地址添加' })).toBeNull();
  });

  it('a dead session goes to sign-in', async () => {
    mockCatalog.mockRejectedValue(new AuthError('session expired'));
    await open('/connectors', '/connectors/add');
    expect(pathname()).toBe('/');
  });
});

describe('Catalog entry', () => {
  it('shows where the agent will connect, how it signs in, and the About link for an https source', async () => {
    await open('/connectors', '/connectors/add', '/connectors/catalog/linear');
    expect(screen.getByText('Issues and projects from Linear.')).toBeTruthy();
    expect(screen.getByText('https://mcp.linear.app/mcp')).toBeTruthy();
    expect(screen.getByText('OAuth 登录')).toBeTruthy();
    expect(screen.getByRole('link', { name: '关于此连接器' })).toBeTruthy();
  });

  it('has no About link when the source is not https', async () => {
    mockCatalog.mockResolvedValue({ entries: [entry({ source: 'javascript:alert(1)' })], diagnostics: [] });
    await open('/connectors', '/connectors/add', '/connectors/catalog/linear');
    expect(screen.queryByRole('link', { name: '关于此连接器' })).toBeNull();
  });

  it('installing a no-auth entry lands on its detail with the list underneath, without asking for a sign-in', async () => {
    mockInstall.mockResolvedValue({ ok: true, name: 'docs', background: false });
    await open('/connectors', '/connectors/add', '/connectors/catalog/docs');
    mockList.mockResolvedValue([server({ name: 'docs', auth: null, url: 'https://docs.example/mcp' })]);
    await pressAdd();
    await flush(20);
    expect(mockAuthenticate).not.toHaveBeenCalled(); // no credential is sent
    expect(mockInstall).toHaveBeenCalledWith({}, 'docs', {}, null);
    expect(pathname()).toBe('/connectors/server/docs');
    expect(mockRequestSignIn).not.toHaveBeenCalled();
    expect(getMcpChangePending()).toBe(true);
    await act(async () => router.back());
    await flush();
    expect(pathname()).toBe('/connectors'); // not the catalog, not the form
  });

  it('installing an OAuth entry asks the detail to start a sign-in — in memory, not in the route', async () => {
    mockInstall.mockResolvedValue({ ok: true, name: 'linear', background: false });
    await open('/connectors', '/connectors/add', '/connectors/catalog/linear');
    mockList.mockResolvedValue([server()]);
    await pressAdd();
    await flush(20);
    expect(mockRequestSignIn).toHaveBeenCalledWith('linear');
    expect(pathname()).toBe('/connectors/server/linear');
  });

  it('credentials: Face ID first, then the values go only to the install call', async () => {
    mockInstall.mockResolvedValue({ ok: true, name: 'asana', background: false });
    await open('/connectors', '/connectors/add', '/connectors/catalog/asana');
    await fireEvent.changeText(screen.getByLabelText('Asana client ID'), 'client-1');
    await fireEvent.changeText(screen.getByLabelText('Asana client secret'), SECRET);
    expect(screen.getByLabelText('Asana client secret').props.secureTextEntry).toBe(true);
    expect(screen.getByLabelText('Asana client ID').props.secureTextEntry).toBe(false);
    mockList.mockResolvedValue([server({ name: 'asana' })]);
    await pressAdd();
    await flush(20);
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    expect(mockInstall).toHaveBeenCalledWith({}, 'asana', { ASANA_CLIENT_ID: 'client-1', ASANA_CLIENT_SECRET: SECRET }, null);
    expect(pathname()).toBe('/connectors/server/asana');
  });

  it('Face ID cancelled: nothing is sent', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'cancelled' });
    await open('/connectors', '/connectors/add', '/connectors/catalog/asana');
    await fireEvent.changeText(screen.getByLabelText('Asana client ID'), 'client-1');
    await fireEvent.changeText(screen.getByLabelText('Asana client secret'), SECRET);
    await pressAdd();
    await flush();
    expect(mockInstall).not.toHaveBeenCalled();
    expect(screen.getByText('已取消，未发送任何内容。')).toBeTruthy();
  });

  it('a failed install shows the reason and, with credentials, that they may already be stored', async () => {
    mockInstall.mockRejectedValue(new HttpError(400, '网关拒绝添加此连接器。'));
    await open('/connectors', '/connectors/add', '/connectors/catalog/asana');
    await fireEvent.changeText(screen.getByLabelText('Asana client ID'), 'client-1');
    await fireEvent.changeText(screen.getByLabelText('Asana client secret'), SECRET);
    await pressAdd();
    await flush(20);
    expect(
      screen.getByText('网关拒绝添加此连接器。 你输入的内容可能已保存到网关。'),
    ).toBeTruthy();
    expect(pathname()).toBe('/connectors/catalog/asana');
    expect(mockCatalog.mock.calls.length).toBeGreaterThan(2); // it looked again before letting him retry
  });

  it('a failed install without credentials shows only the reason', async () => {
    mockInstall.mockRejectedValue(new HttpError(400, "No catalog entry 'docs'"));
    await open('/connectors', '/connectors/add', '/connectors/catalog/docs');
    await pressAdd();
    await flush(20);
    expect(screen.getByText("No catalog entry 'docs'")).toBeTruthy();
  });

  it('an install whose answer was lost but which did install goes to the connector', async () => {
    mockInstall.mockImplementation(async () => {
      mockCatalog.mockResolvedValue({ entries: [{ ...DOCS, installed: true }], diagnostics: [] });
      mockList.mockResolvedValue([server({ name: 'docs', auth: null })]);
      throw new HttpError(0, 'request timed out after 45s');
    });
    await open('/connectors', '/connectors/add', '/connectors/catalog/docs');
    await pressAdd();
    await flush(30);
    expect(pathname()).toBe('/connectors/server/docs');
    expect(getMcpChangePending()).toBe(true);
  });

  it('nothing was sent (the fast request failed): no "may already be stored", and no second look', async () => {
    mockInstall.mockRejectedValue(new McpPreflightError(new HttpError(0, 'request timed out after 20s')));
    await open('/connectors', '/connectors/add', '/connectors/catalog/asana');
    await fireEvent.changeText(screen.getByLabelText('Asana client ID'), 'client-1');
    await fireEvent.changeText(screen.getByLabelText('Asana client secret'), SECRET);
    const looks = mockCatalog.mock.calls.length;
    await pressAdd();
    await flush(20);
    expect(screen.getByText('网关响应超时。')).toBeTruthy();
    expect(mockCatalog.mock.calls.length).toBe(looks);
  });

  it('already added elsewhere: says so and offers Open, without navigating or asking for a sign-in', async () => {
    mockInstall.mockImplementation(async () => {
      mockCatalog.mockResolvedValue({ entries: [entry({ installed: true })], diagnostics: [] });
      throw new McpAlreadyAddedError('linear');
    });
    await open('/connectors', '/connectors/add', '/connectors/catalog/linear');
    await pressAdd();
    await flush(20);
    expect(pathname()).toBe('/connectors/catalog/linear');
    expect(screen.getByText('已添加')).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开连接器' })).toBeTruthy();
    expect(mockRequestSignIn).not.toHaveBeenCalled();
    expect(getMcpChangePending()).toBe(false);
  });

  it('leaving while the install is out: its late success does not navigate', async () => {
    let finish!: (v: unknown) => void;
    mockInstall.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await open('/connectors', '/connectors/add', '/connectors/catalog/docs');
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '添加连接器' }));
    });
    await flush();
    await act(async () => router.dismissTo('/' as never));
    await flush();
    await act(async () => finish({ ok: true, name: 'docs', background: false }));
    await flush(20);
    expect(pathname()).toBe('/');
    expect(getMcpChangePending()).toBe(true); // it was installed all the same
  });

  it('a dead session during the install goes to sign-in', async () => {
    mockInstall.mockRejectedValue(new AuthError('session expired'));
    await open('/connectors', '/connectors/add', '/connectors/catalog/docs');
    await pressAdd();
    await flush(20);
    expect(pathname()).toBe('/');
  });

  it('an unknown entry says so', async () => {
    await open('/connectors', '/connectors/add', '/connectors/catalog/nope');
    expect(screen.getByText('目录中未找到')).toBeTruthy();
  });
});

describe('自定义服务器', () => {
  const url = () => screen.getByLabelText('服务器地址');
  const name = () => screen.getByLabelText('名称');
  const choose = (label: string) =>
    act(async () => {
      await fireEvent.press(screen.getByRole('radio', { name: label }));
    });

  it('suggests a name from the URL until he edits the name', async () => {
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://mcp.linear.app/mcp');
    expect(name().props.value).toBe('linear');
    await fireEvent.changeText(name(), 'mine');
    await fireEvent.changeText(url(), 'https://gws.mcp.gldc.io/');
    expect(name().props.value).toBe('mine');
  });

  it('checks the name and URL before sending anything', async () => {
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await pressAdd();
    expect(screen.getByText('请输入服务器地址。')).toBeTruthy();
    expect(screen.getByText('请输入名称。')).toBeTruthy();
    await fireEvent.changeText(url(), 'ftp://x.example');
    expect(screen.getByText('请输入以 https:// 开头的地址。')).toBeTruthy();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('cautions on http as soon as it is typed', async () => {
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'http://10.0.0.5:8000/mcp');
    expect(screen.getByText('网关与此服务器之间的通信不会加密。')).toBeTruthy();
  });

  it('no auth: adds without Face ID and lands on the detail', async () => {
    mockAdd.mockResolvedValue(server({ name: 'mine', auth: null, url: 'https://x.example/mcp' }));
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await fireEvent.changeText(name(), 'mine');
    mockList.mockResolvedValue([server({ name: 'mine', auth: null, url: 'https://x.example/mcp' })]);
    await pressAdd();
    await flush(20);
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledWith({}, { name: 'mine', url: 'https://x.example/mcp', auth: 'none' }, null);
    expect(pathname()).toBe('/connectors/server/mine');
    expect(mockRequestSignIn).not.toHaveBeenCalled();
    expect(getMcpChangePending()).toBe(true);
    await act(async () => router.back());
    await flush();
    expect(pathname()).toBe('/connectors');
  });

  it('bearer token: Face ID first; the token goes only into the add call, never into the route', async () => {
    mockAdd.mockResolvedValue(server({ name: 'mine', auth: 'header', url: 'https://x.example/mcp' }));
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await choose('Bearer 令牌');
    await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
    mockList.mockResolvedValue([server({ name: 'x', auth: 'header', url: 'https://x.example/mcp' })]);
    const order: string[] = [];
    mockAuthenticate.mockImplementation(async () => {
      order.push('face-id');
      return { ok: true };
    });
    mockAdd.mockImplementation(async () => {
      order.push('add');
      return server({ name: 'x', auth: 'header', url: 'https://x.example/mcp' });
    });
    await pressAdd();
    await flush(20);
    expect(order).toEqual(['face-id', 'add']);
    expect(mockAdd).toHaveBeenCalledWith({}, { name: 'x', url: 'https://x.example/mcp', auth: 'header', bearer_token: SECRET }, null);
    expect(pathname()).toBe('/connectors/server/x');
    expect(fullPath()).not.toContain(SECRET);
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    expect(screen.queryByText(new RegExp(SECRET))).toBeNull();
  });

  it('bearer token without a token stops before Face ID', async () => {
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await choose('Bearer 令牌');
    await pressAdd();
    expect(screen.getByText('令牌不能为空。')).toBeTruthy();
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('switching the authentication away from Bearer 令牌 drops what was typed', async () => {
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await choose('Bearer 令牌');
    await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
    await choose('无');
    expect(screen.queryByLabelText('令牌')).toBeNull();
    await choose('Bearer 令牌');
    expect(screen.getByLabelText('令牌').props.value).toBe('');
  });

  it('OAuth: adds, then asks the detail to start the sign-in', async () => {
    mockAdd.mockResolvedValue(server({ name: 'x', auth: 'oauth', url: 'https://x.example/mcp' }));
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await choose('OAuth');
    mockList.mockResolvedValue([server({ name: 'x', url: 'https://x.example/mcp' })]);
    await pressAdd();
    await flush(20);
    expect(mockAdd).toHaveBeenCalledWith({}, { name: 'x', url: 'https://x.example/mcp', auth: 'oauth' }, null);
    expect(mockRequestSignIn).toHaveBeenCalledWith('x');
    expect(pathname()).toBe('/connectors/server/x');
  });

  it('OAuth is refused, with the reason, when the gateway is not on https', async () => {
    mockBaseUrl = 'http://100.89.28.11:9119';
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await choose('OAuth');
    expect(screen.getByText('OAuth 登录需要网关使用 HTTPS 地址。')).toBeTruthy();
    await pressAdd();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('a name that exists shows the gateway’s reason and stays on the form', async () => {
    mockAdd.mockRejectedValue(new HttpError(409, "Server 'x' already exists"));
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await pressAdd();
    await flush(20);
    expect(screen.getByText("Server 'x' already exists")).toBeTruthy();
    expect(pathname()).toBe('/connectors/custom');
    expect(getMcpChangePending()).toBe(false);
  });

  it('an answer that never arrived: goes to the connector only if the gateway now has THIS server', async () => {
    mockAdd.mockImplementation(async () => {
      mockList.mockResolvedValue([server({ name: 'x', auth: null, url: 'https://x.example/mcp' })]);
      throw new HttpError(0, 'request timed out after 20s');
    });
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await pressAdd();
    await flush(30);
    expect(pathname()).toBe('/connectors/server/x');
  });

  it('an answer that never arrived, and a different server already has that name: stays and says so', async () => {
    mockAdd.mockImplementation(async () => {
      mockList.mockResolvedValue([server({ name: 'x', url: 'https://someone-else.example/mcp' })]);
      throw new HttpError(0, 'request timed out after 20s');
    });
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await pressAdd();
    await flush(30);
    expect(pathname()).toBe('/connectors/custom');
    expect(screen.getByText('网关响应超时。 请先检查列表再重试。')).toBeTruthy();
    expect(mockRequestSignIn).not.toHaveBeenCalled();
  });

  it('the fields are locked while the request is out', async () => {
    let finish!: (v: McpServer) => void;
    mockAdd.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '添加连接器' }));
    });
    await flush();
    expect(url().props.editable).toBe(false);
    expect(name().props.editable).toBe(false);
    expect(screen.getByRole('radio', { name: 'OAuth' })).toBeDisabled();
    await act(async () => finish(server({ name: 'x', auth: null, url: 'https://x.example/mcp' })));
    await flush(20);
  });

  it('a dead session goes to sign-in', async () => {
    mockAdd.mockRejectedValue(new AuthError('session expired'));
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(url(), 'https://x.example/mcp');
    await pressAdd();
    await flush(20);
    expect(pathname()).toBe('/');
  });
});

describe('MCP 连接器 list — entry points', () => {
  it('the empty state offers to add a connector', async () => {
    await open('/connectors');
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: '添加第一个连接器' }));
    });
    await flush();
    expect(pathname()).toBe('/connectors/add');
  });

  it('no add entry point on a gateway that does not support connectors', async () => {
    mockList.mockRejectedValue(new HttpError(404, 'Not Found'));
    await open('/connectors');
    expect(screen.queryByRole('button', { name: '添加连接器' })).toBeNull();
  });
});

// --- branch review: a late answer must not pull him away from where he went -----------------

describe('A request that answers after he went elsewhere', () => {
  it('catalog install: a chat opened on top stays; the entry reads 已添加 when he returns', async () => {
    let finish!: (v: unknown) => void;
    mockInstall.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await open('/connectors', '/connectors/add', '/connectors/catalog/linear');
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '添加连接器' }));
    });
    await flush();
    await act(async () => router.navigate('/chat/abc' as never)); // e.g. a notification tap
    await flush();
    expect(pathname()).toBe('/chat/abc');

    mockCatalog.mockResolvedValue({ entries: [entry({ installed: true })], diagnostics: [] });
    await act(async () => finish({ ok: true, name: 'linear', background: false }));
    await flush(20);
    expect(pathname()).toBe('/chat/abc');
    expect(mockRequestSignIn).not.toHaveBeenCalled(); // no sign-in page opening by itself later
    expect(getMcpChangePending()).toBe(true);

    await act(async () => router.back());
    await flush();
    expect(pathname()).toBe('/connectors/catalog/linear');
    expect(screen.getByText('已添加')).toBeTruthy();
  });

  it('custom add: a chat opened on top stays; the form says it was added', async () => {
    let finish!: (v: McpServer) => void;
    mockAdd.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(screen.getByLabelText('服务器地址'), 'https://x.example/mcp');
    await act(async () => {
      await fireEvent.press(screen.getByRole('radio', { name: 'OAuth' }));
    });
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '添加连接器' }));
    });
    await flush();
    await act(async () => router.navigate('/chat/abc' as never));
    await flush();
    await act(async () => finish(server({ name: 'x', url: 'https://x.example/mcp' })));
    await flush(20);
    expect(pathname()).toBe('/chat/abc');
    expect(mockRequestSignIn).not.toHaveBeenCalled();
    expect(getMcpChangePending()).toBe(true);
    await act(async () => router.back());
    await flush();
    expect(screen.getByText('已添加，可从连接器列表打开。')).toBeTruthy();
  });

  it('custom add: leaving the form altogether — its late success does not navigate', async () => {
    let finish!: (v: McpServer) => void;
    mockAdd.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(screen.getByLabelText('服务器地址'), 'https://x.example/mcp');
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '添加连接器' }));
    });
    await flush();
    await act(async () => router.dismissTo('/' as never));
    await flush();
    await act(async () => finish(server({ name: 'x', auth: null, url: 'https://x.example/mcp' })));
    await flush(20);
    expect(pathname()).toBe('/');
    expect(getMcpChangePending()).toBe(true);
  });
});

describe('Branch review: smaller cases', () => {
  it('"already added" always says so, even when the catalog still reads not installed (a plugin server of that name)', async () => {
    mockInstall.mockRejectedValue(new McpAlreadyAddedError('linear'));
    await open('/connectors', '/connectors/add', '/connectors/catalog/linear');
    await pressAdd();
    await flush(20);
    expect(screen.getByText('此连接器已添加。')).toBeTruthy();
  });

  it('a catalog OAuth entry is not added when the gateway is not on https; the entry says why', async () => {
    mockBaseUrl = 'http://100.89.28.11:9119';
    await open('/connectors', '/connectors/add', '/connectors/catalog/linear');
    expect(screen.getByText('OAuth 登录需要网关使用 HTTPS 地址。')).toBeTruthy();
    await pressAdd();
    await flush();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('a no-auth entry is unaffected by an http gateway', async () => {
    mockBaseUrl = 'http://100.89.28.11:9119';
    mockInstall.mockResolvedValue({ ok: true, name: 'docs', background: false });
    await open('/connectors', '/connectors/add', '/connectors/catalog/docs');
    await pressAdd();
    await flush(20);
    expect(mockInstall).toHaveBeenCalled();
  });

  it('catalog credentials never end up in the route', async () => {
    mockInstall.mockResolvedValue({ ok: true, name: 'asana', background: false });
    await open('/connectors', '/connectors/add', '/connectors/catalog/asana');
    await fireEvent.changeText(screen.getByLabelText('Asana client ID'), 'client-1');
    await fireEvent.changeText(screen.getByLabelText('Asana client secret'), SECRET);
    mockList.mockResolvedValue([server({ name: 'asana' })]);
    await pressAdd();
    await flush(20);
    expect(pathname()).toBe('/connectors/server/asana');
    expect(fullPath()).not.toContain(SECRET);
    expect(fullPath()).not.toContain('client-1');
  });

  it('after a failed add the token is on screen exactly once: in its own field', async () => {
    mockAdd.mockRejectedValue(new HttpError(409, "Server 'x' already exists"));
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(screen.getByLabelText('服务器地址'), 'https://x.example/mcp');
    await act(async () => {
      await fireEvent.press(screen.getByRole('radio', { name: 'Bearer 令牌' }));
    });
    await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
    await pressAdd();
    await flush(20);
    expect(screen.getByText("Server 'x' already exists")).toBeTruthy();
    expect(screen.getAllByDisplayValue(SECRET)).toHaveLength(1);
    expect(screen.queryAllByText(new RegExp(SECRET))).toHaveLength(0);
    expect(fullPath()).not.toContain(SECRET);
  });

  it('the authentication choices are radios that report which one is checked', async () => {
    await open('/connectors', '/connectors/add', '/connectors/custom');
    expect(screen.getByRole('radio', { name: '无' }).props.accessibilityState.checked).toBe(true);
    await act(async () => {
      await fireEvent.press(screen.getByRole('radio', { name: 'OAuth' }));
    });
    expect(screen.getByRole('radio', { name: 'OAuth' }).props.accessibilityState.checked).toBe(true);
    expect(screen.getByRole('radio', { name: '无' }).props.accessibilityState.checked).toBe(false);
  });

  it('a URL that carries a key or credentials gets a caution', async () => {
    await open('/connectors', '/connectors/add', '/connectors/custom');
    await fireEvent.changeText(screen.getByLabelText('服务器地址'), 'https://x.example/mcp?api_key=abc');
    expect(screen.getByText(/此地址包含密钥或凭据/)).toBeTruthy();
  });
});
