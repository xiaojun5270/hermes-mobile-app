// Connectors list and detail: how they behave around the chat socket (status lines, Test) and
// around a failed switch. The REST layer is mocked; the session-mcp-store is the real one.
import { Stack, router } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Alert, Text } from 'react-native';
import type { McpServer } from '../src/api/mcp';
import type { McpReloadOutcome, McpRuntimeRow, McpTestOutcome } from '../src/api/mcpSession';
import { AuthError, HttpError } from '../src/api/restClient';
import ConnectorsScreen from '../src/app/connectors';
import ConnectorDetailScreen from '../src/app/connectors/server/[name]';
import {
  __resetSessionMcpStore,
  clearSessionMcpTarget,
  getMcpChangePending,
  markMcpChanged,
  publishSessionMcpTarget,
  type SessionMcpTarget,
} from '../src/session-mcp-store';

jest.mock('../src/components/icon', () => ({ Icon: () => null }));
jest.mock('../src/connection', () => ({
  withAuthRetry: (fn: (r: unknown) => Promise<unknown>) => fn({}),
}));
const mockList = jest.fn();
const mockSet = jest.fn();
const mockRemove = jest.fn();
jest.mock('../src/api/mcp', () => ({
  ...jest.requireActual('../src/api/mcp'),
  listMcpServers: (...a: unknown[]) => mockList(...a),
  setMcpServerEnabled: (...a: unknown[]) => mockSet(...a),
  removeMcpServer: (...a: unknown[]) => mockRemove(...a),
}));

// The sign-in hook, with real `phase` state so the screen's busy rules can be seen. What a
// sign-in answers is `mockSignIn`; the sequence itself is tested in mcp-oauth and connector-sign-in.
const mockSignIn = jest.fn();
const mockConsume = jest.fn();
const mockDrop = jest.fn();
jest.mock('../src/components/connector-sign-in', () => {
  const React = jest.requireActual('react');
  return {
    useConnectorSignIn: () => {
      const [phase, setPhase] = React.useState(null);
      const signIn = React.useCallback(async (name: string) => {
        setPhase('browser');
        try {
          return await mockSignIn(name);
        } finally {
          setPhase(null);
        }
      }, []);
      const cancel = React.useCallback(() => {}, []);
      return { phase, cancelling: false, signIn, cancel };
    },
    consumeSignInRequest: (name: string) => mockConsume(name),
    dropSignInRequest: (name: string) => mockDrop(name),
    requestSignInOnOpen: () => {},
    gatewayBaseUrl: () => mockGatewayBase,
  };
});
let mockGatewayBase: string | null = 'https://hermes.kite-opah.ts.net';

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

const local = server({ name: 'yt', transport: 'stdio', url: null, command: 'uvx', auth: null });

const owner = {};
let statusCalls = 0;
let testCalls: { resolve: (o: McpTestOutcome) => void }[] = [];
let reloads = 0;
let reloadOutcome: McpReloadOutcome = { kind: 'reloaded', thisChatOnly: false };
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

/** A chat's target: status answers at once, tests stay pending until the case resolves them.
 * `linearRow` overrides what the gateway reports for the `linear` connector. */
function target(connected: boolean, linearRow: Partial<McpRuntimeRow> = {}): SessionMcpTarget {
  return {
    connected,
    streaming: false,
    status: async () => {
      statusCalls++;
      return [
        { name: 'linear', transport: 'http', tools: 3, connected: true, disabled: false, status: 'connected', source: 'config', plugin: null, ...linearRow },
      ];
    },
    test: () => new Promise<McpTestOutcome>((resolve) => testCalls.push({ resolve })),
    reload: async () => {
      reloads++;
      return reloadOutcome;
    },
  };
}

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

let pathname: () => string;

async function open(url: string) {
  const rendered = renderRouter(
    {
      _layout: () => <Stack />,
      index: () => <Text>sign in</Text>,
      connectors: ConnectorsScreen,
      'connectors/server/[name]': ConnectorDetailScreen,
      'chat/[id]': () => <Text>a chat</Text>,
    },
    { initialUrl: '/' },
  );
  pathname = () => rendered.getPathname();
  await rendered;
  await act(async () => router.push(url as never));
  await flush();
}

beforeEach(() => {
  __resetSessionMcpStore();
  statusCalls = 0;
  testCalls = [];
  reloads = 0;
  reloadOutcome = { kind: 'reloaded', thisChatOnly: false };
  alertSpy.mockClear();
  mockList.mockReset();
  mockSet.mockReset();
  mockRemove.mockReset();
  mockSignIn.mockReset();
  mockConsume.mockReset();
  mockDrop.mockReset();
  mockConsume.mockReturnValue(false);
  mockList.mockImplementation(async () => [server(), local]);
});

describe('MCP 连接器 list', () => {
  it('shows the status line when a chat socket is connected, and does not refetch in a loop', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors');
    expect(screen.getByText('已连接 · 3 个工具')).toBeTruthy();
    expect(screen.getByText('重新加载或重启网关后，智能体才会使用修改后的配置。')).toBeTruthy();
    const before = mockList.mock.calls.length;
    await flush(50);
    expect(mockList.mock.calls.length).toBe(before);
    expect(before).toBe(1);
  });

  it('loads without a chat socket: rows, no status lines; fills them in when the socket arrives; drops them when it goes', async () => {
    await open('/connectors');
    expect(screen.getByText('linear')).toBeTruthy();
    expect(screen.getByText('yt')).toBeTruthy();
    expect(screen.queryByText(/Connected/)).toBeNull();
    expect(statusCalls).toBe(0);

    await act(async () => publishSessionMcpTarget(owner, target(true)));
    await flush();
    expect(screen.getByText('已连接 · 3 个工具')).toBeTruthy();
    expect(mockList.mock.calls.length).toBe(1); // the status arriving does not refetch the list

    await act(async () => publishSessionMcpTarget(owner, target(false))); // the chat is reconnecting
    await flush();
    expect(screen.queryByText(/Connected/)).toBeNull();

    await act(async () => clearSessionMcpTarget(owner)); // the chat unmounted
    await flush();
    expect(screen.queryByText(/Connected/)).toBeNull();
    expect(screen.getByText('linear')).toBeTruthy();
  });

  it('a switch that fails with 404 says the connector is gone, and the message survives the re-read', async () => {
    await open('/connectors');
    mockSet.mockRejectedValue(new HttpError(404, "Server 'linear' not found"));
    mockList.mockImplementation(async () => [local]);
    await act(async () => fireEvent(screen.getAllByRole('switch')[0], 'valueChange', false));
    await flush(30);
    expect(mockSet).toHaveBeenCalledWith({}, 'linear', false, null);
    expect(screen.getByText('此连接器已不存在。')).toBeTruthy();
    expect(screen.queryByText('linear')).toBeNull();
    expect(screen.getByText('yt')).toBeTruthy();
  });

  it('a switch that fails on the network reverts, says why, and re-reads the list', async () => {
    await open('/connectors');
    mockSet.mockRejectedValue(new TypeError('Network request failed'));
    await act(async () => fireEvent(screen.getAllByRole('switch')[0], 'valueChange', false));
    await flush(30);
    expect(screen.getAllByRole('switch')[0].props.value).toBe(true);
    expect(screen.getByText('无法连接网关，请检查 VPN 或 Wi-Fi。')).toBeTruthy();
    expect(mockList.mock.calls.length).toBe(2);
  });

  it('a switch that succeeds keeps the new value and does not re-read', async () => {
    await open('/connectors');
    mockSet.mockResolvedValue({ ok: true, name: 'linear', enabled: false });
    await act(async () => fireEvent(screen.getAllByRole('switch')[0], 'valueChange', false));
    await flush();
    expect(screen.getAllByRole('switch')[0].props.value).toBe(false);
    expect(mockList.mock.calls.length).toBe(1);
  });

  it('a gateway without the connector routes gets its own empty state', async () => {
    mockList.mockRejectedValue(new HttpError(404, 'Not Found'));
    await open('/connectors');
    expect(screen.getByText('连接器不可用')).toBeTruthy();
    expect(screen.getByText('此网关不支持连接器，需要 Hermes 0.21.5 或更新版本。')).toBeTruthy();
  });

  it('no connectors: the empty state', async () => {
    mockList.mockImplementation(async () => []);
    await open('/connectors');
    expect(screen.getByText('暂无连接器')).toBeTruthy();
    expect(screen.queryByText('重新加载或重启网关后，智能体才会使用修改后的配置。')).toBeNull();
  });

  it('a dead session goes to sign-in', async () => {
    mockList.mockRejectedValue(new AuthError('session expired'));
    await open('/connectors');
    expect(pathname()).toBe('/');
  });

  it('pressing a row opens its detail', async () => {
    await open('/connectors');
    await act(async () => fireEvent.press(screen.getByRole('button', { name: /^yt 连接器/ })));
    await flush();
    expect(pathname()).toBe('/connectors/server/yt');
  });
});

describe('连接器 detail', () => {
  it('tests a remote connector once when it opens, and not again across a reconnect', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    expect(testCalls).toHaveLength(1);
    expect(screen.getByText('正在测试…')).toBeTruthy();
    expect(screen.getByText('已连接 · 3 个工具')).toBeTruthy(); // the Status field

    await act(async () => publishSessionMcpTarget(owner, target(false)));
    await flush();
    await act(async () => publishSessionMcpTarget(owner, target(true)));
    await flush();
    expect(testCalls).toHaveLength(1);
    expect(mockList.mock.calls.length).toBe(1); // the socket flipping does not refetch over REST

    await act(async () =>
      testCalls[0].resolve({ kind: 'ok', tools: [{ name: 'search', description: 'Search issues' }], prompts: 0, resources: 0, tokensPresent: true }),
    );
    await flush();
    expect(screen.getByText('连接正常 · 1 个工具')).toBeTruthy();
    expect(screen.getByText('search')).toBeTruthy();
  });

  it('without a chat socket Test is disabled with the reason; it runs when the socket arrives', async () => {
    await open('/connectors/server/linear');
    expect(testCalls).toHaveLength(0);
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
    expect(
      screen.getByText('请先返回会话并等待连接成功，再回来测试。'),
    ).toBeTruthy();
    await act(async () => publishSessionMcpTarget(owner, target(true)));
    await flush();
    expect(testCalls).toHaveLength(1);
  });

  it('a local connector is not tested until asked; the button is disabled while a test runs', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/yt');
    await flush(20);
    expect(testCalls).toHaveLength(0);
    expect(screen.getByText('uvx')).toBeTruthy();

    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: '测试连接' }));
    });
    await flush();
    expect(testCalls).toHaveLength(1);
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();

    await act(async () => testCalls[0].resolve({ kind: 'ok', tools: [], prompts: 0, resources: 0, tokensPresent: null }));
    await flush();
    expect(screen.getByText('连接正常 · 0 个工具')).toBeTruthy();
    expect(screen.getByRole('button', { name: '测试连接' })).not.toBeDisabled();
  });

  it('a switch that fails with 404 says so and re-reads; the connector is then gone', async () => {
    await open('/connectors/server/linear');
    mockSet.mockRejectedValue(new HttpError(404, "Server 'linear' not found"));
    mockList.mockImplementation(async () => [local]);
    await act(async () => fireEvent(screen.getByRole('switch'), 'valueChange', false));
    await flush(30);
    expect(screen.getByText('此连接器已不存在。')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('a switch that times out reverts, says to check, and re-reads what the gateway has', async () => {
    await open('/connectors/server/linear');
    mockSet.mockRejectedValue(new HttpError(0, 'request timed out after 20s'));
    mockList.mockImplementation(async () => [server({ enabled: false }), local]); // the write had landed
    await act(async () => fireEvent(screen.getByRole('switch'), 'valueChange', false));
    await flush(30);
    expect(screen.getByText('网关响应超时。')).toBeTruthy();
    expect(screen.getByRole('switch').props.value).toBe(false);
  });

  it('an unknown name shows 未找到连接器', async () => {
    await open('/connectors/server/nope');
    expect(screen.getByText('未找到连接器')).toBeTruthy();
  });

  it('a plugin connector has no switch, and says where to change it', async () => {
    mockList.mockImplementation(async () => [server({ source: 'plugin', plugin: 'acme' })]);
    await open('/connectors/server/linear');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('插件：acme')).toBeTruthy();
    expect(screen.getByText(/由插件提供/)).toBeTruthy();
  });
});

// --- reads and writes that overlap (branch review, finding 1) --------------------------------

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const refreshControl = (testID: string) => screen.getByTestId(testID).props.refreshControl.props;
const firstSwitch = () => screen.getAllByRole('switch')[0];
/** Run something whose promise may stay pending (a deferred request) without act() waiting on it. */
const kick = (fn: () => unknown) =>
  act(async () => {
    void fn();
  });

describe('MCP 连接器 list — spinner and focus', () => {
  it('spins until the first read settles', async () => {
    const d = deferred<McpServer[]>();
    mockList.mockImplementation(() => d.promise);
    await open('/connectors');
    expect(refreshControl('connectors-list').refreshing).toBe(true);
    await act(async () => d.resolve([server()]));
    await flush();
    expect(refreshControl('connectors-list').refreshing).toBe(false);
    expect(screen.getByText('linear')).toBeTruthy();
  });

  it('re-reads when it regains focus, without the spinner, and clears an old error', async () => {
    await open('/connectors');
    mockSet.mockRejectedValue(new TypeError('Network request failed'));
    await kick(() => fireEvent(firstSwitch(), 'valueChange', false));
    await flush(30);
    expect(screen.getByText('无法连接网关，请检查 VPN 或 Wi-Fi。')).toBeTruthy();
    const before = mockList.mock.calls.length;

    await act(async () => router.push('/connectors/server/yt' as never));
    await flush();
    const d = deferred<McpServer[]>();
    mockList.mockImplementation(() => d.promise);
    await act(async () => router.back());
    await flush();
    expect(mockList.mock.calls.length).toBeGreaterThan(before);
    expect(refreshControl('connectors-list').refreshing).toBe(false); // silent
    expect(screen.queryByText('无法连接网关，请检查 VPN 或 Wi-Fi。')).toBeNull();
    await act(async () => d.resolve([server({ enabled: false }), local]));
    await flush();
    expect(firstSwitch().props.value).toBe(false); // a change made elsewhere shows on return
  });

  it('pull to refresh spins until ITS read settles; an older read landing first is dropped', async () => {
    await open('/connectors');
    await act(async () => router.push('/connectors/server/yt' as never));
    await flush();
    const older = deferred<McpServer[]>();
    mockList.mockImplementation(() => older.promise);
    await act(async () => router.back()); // silent focus read, still in flight
    await flush();

    const pulled = deferred<McpServer[]>();
    mockList.mockImplementation(() => pulled.promise);
    await kick(() => refreshControl('connectors-list').onRefresh());
    await flush();
    expect(refreshControl('connectors-list').refreshing).toBe(true);

    await act(async () => older.reject(new HttpError(0, 'request timed out after 20s')));
    await flush();
    expect(refreshControl('connectors-list').refreshing).toBe(true); // not stopped by the older read
    expect(screen.queryByText('网关响应超时。')).toBeNull(); // nor its error shown

    await act(async () => pulled.resolve([server(), local]));
    await flush();
    expect(refreshControl('connectors-list').refreshing).toBe(false);
  });
});

describe('MCP 连接器 list — a switch against other requests', () => {
  it('a read that was in flight when the switch was flipped cannot put the old value back', async () => {
    await open('/connectors');
    const read = deferred<McpServer[]>();
    mockList.mockImplementation(() => read.promise);
    await kick(() => refreshControl('connectors-list').onRefresh());
    await flush();

    const write = deferred<{ ok: boolean; name: string; enabled: boolean }>();
    mockSet.mockImplementation(() => write.promise);
    await kick(() => fireEvent(firstSwitch(), 'valueChange', false));
    await flush();
    expect(firstSwitch().props.value).toBe(false);

    await act(async () => read.resolve([server({ enabled: true }), local])); // pre-write data
    await flush();
    expect(firstSwitch().props.value).toBe(false);

    mockList.mockImplementation(async () => [server({ enabled: false }), local]);
    await act(async () => write.resolve({ ok: true, name: 'linear', enabled: false }));
    await flush(30);
    expect(firstSwitch().props.value).toBe(false);
    expect(refreshControl('connectors-list').refreshing).toBe(false); // the dropped pull does not leave it spinning
  });

  it('a second tap on the same switch while the first is pending is ignored', async () => {
    await open('/connectors');
    const write = deferred<{ ok: boolean; name: string; enabled: boolean }>();
    mockSet.mockImplementation(() => write.promise);
    await kick(() => fireEvent(firstSwitch(), 'valueChange', false));
    await flush();
    await kick(() => fireEvent(firstSwitch(), 'valueChange', true));
    await flush();
    expect(mockSet).toHaveBeenCalledTimes(1);
    await act(async () => write.resolve({ ok: true, name: 'linear', enabled: false }));
    await flush();
    expect(firstSwitch().props.value).toBe(false);
  });

  it('a failed switch reverts even when the re-read fails too, and keeps the first message', async () => {
    await open('/connectors');
    mockSet.mockRejectedValue(new HttpError(404, "Server 'linear' not found"));
    mockList.mockRejectedValue(new TypeError('Network request failed'));
    await kick(() => fireEvent(firstSwitch(), 'valueChange', false));
    await flush(30);
    expect(firstSwitch().props.value).toBe(true); // reverted by the screen, not by a re-read
    expect(screen.getByText('此连接器已不存在。')).toBeTruthy();
    expect(screen.queryByText('无法连接网关，请检查 VPN 或 Wi-Fi。')).toBeNull();
  });
});

describe('连接器 detail — a switch against other requests', () => {
  it('a failed switch reverts even when the re-read fails too', async () => {
    await open('/connectors/server/linear');
    mockSet.mockRejectedValue(new HttpError(409, 'Config is locked'));
    mockList.mockRejectedValue(new TypeError('Network request failed'));
    await kick(() => fireEvent(screen.getByRole('switch'), 'valueChange', false));
    await flush(30);
    expect(screen.getByRole('switch').props.value).toBe(true);
    expect(screen.getByText('Config is locked')).toBeTruthy();
  });

  it('a refresh that was in flight cannot wipe a failed switch’s message', async () => {
    await open('/connectors/server/linear');
    const pulled = deferred<McpServer[]>();
    mockList.mockImplementation(() => pulled.promise);
    await kick(() => refreshControl('connector-detail').onRefresh());
    await flush();

    mockSet.mockRejectedValue(new HttpError(409, 'Config is locked'));
    mockList.mockImplementation(async () => [server(), local]);
    await kick(() => fireEvent(screen.getByRole('switch'), 'valueChange', false));
    await flush(30);
    expect(screen.getByText('Config is locked')).toBeTruthy();

    await act(async () => pulled.resolve([server(), local])); // the older read lands last
    await flush();
    expect(screen.getByText('Config is locked')).toBeTruthy();
    expect(refreshControl('connector-detail').refreshing).toBe(false);
  });
});

// --- Reload now (spec §5.7) -------------------------------------------------------------------

describe('MCP 连接器 list — reload', () => {
  const RELOAD_TITLE = '重新加载连接器？';
  const banner = () => screen.queryByText('智能体尚未加载你的修改。');
  const reloadButton = () => screen.getByRole('button', { name: '立即重新加载' });

  /** Press the alert's button with this label (the alert is mocked, so nothing is shown). */
  async function answerAlert(label: string) {
    const call = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
    const button = (call[2] ?? []).find((b) => b.text === label);
    await act(async () => {
      void button?.onPress?.();
    });
    await flush(20);
  }

  it('no banner until something changes', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors');
    expect(banner()).toBeNull();
  });

  it('appears after a switch succeeds', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors');
    mockSet.mockResolvedValue({ ok: true, name: 'linear', enabled: false });
    await act(async () => fireEvent(firstSwitch(), 'valueChange', false));
    await flush();
    expect(banner()).toBeTruthy();
    expect(reloadButton()).not.toBeDisabled();
  });

  it('does not appear after a switch fails', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors');
    mockSet.mockRejectedValue(new HttpError(409, 'Config is locked'));
    await act(async () => fireEvent(firstSwitch(), 'valueChange', false));
    await flush(30);
    expect(banner()).toBeNull();
  });

  it('also appears, with nothing changed in this app session, when the gateway and the config disagree', async () => {
    publishSessionMcpTarget(owner, target(true, { status: 'configured', tools: 0, connected: false }));
    await open('/connectors');
    expect(screen.getByText('尚未加载 · 重新加载后生效')).toBeTruthy();
    expect(banner()).toBeTruthy();
  });

  it('asks first; Cancel does nothing', async () => {
    const t = target(true);
    publishSessionMcpTarget(owner, t);
    markMcpChanged();
    await open('/connectors');
    await act(async () => {
      await fireEvent.press(reloadButton());
    });
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe(RELOAD_TITLE);
    expect(alertSpy.mock.calls[0][1]).toMatch(/所有打开会话/);
    expect(alertSpy.mock.calls[0][1]).toMatch(/重新发送完整上下文/);
    await answerAlert('取消');
    expect(reloads).toBe(0);
    expect(banner()).toBeTruthy();
  });

  it('on confirm it reloads, clears the banner, says Reloaded, and re-reads the list and status', async () => {
    publishSessionMcpTarget(owner, target(true));
    markMcpChanged();
    await open('/connectors');
    const listBefore = mockList.mock.calls.length;
    const statusBefore = statusCalls;
    await act(async () => {
      await fireEvent.press(reloadButton());
    });
    await answerAlert('重新加载');
    expect(reloads).toBe(1);
    expect(banner()).toBeNull();
    expect(screen.getByText('已重新加载。')).toBeTruthy();
    expect(getMcpChangePending()).toBe(false);
    expect(mockList.mock.calls.length).toBe(listBefore + 1);
    expect(statusCalls).toBeGreaterThan(statusBefore);
  });

  it('a compute-host reload says only this chat was reloaded', async () => {
    reloadOutcome = { kind: 'reloaded', thisChatOnly: true };
    publishSessionMcpTarget(owner, target(true));
    markMcpChanged();
    await open('/connectors');
    await act(async () => {
      await fireEvent.press(reloadButton());
    });
    await answerAlert('重新加载');
    expect(screen.getByText('已重新加载，仅对此会话生效。')).toBeTruthy();
  });

  it('a failed reload keeps the banner and shows the gateway message', async () => {
    reloadOutcome = { kind: 'error', message: 'compute-host reload_mcp failed: boom' };
    publishSessionMcpTarget(owner, target(true));
    markMcpChanged();
    await open('/connectors');
    await act(async () => {
      await fireEvent.press(reloadButton());
    });
    await answerAlert('重新加载');
    expect(banner()).toBeTruthy();
    expect(screen.getByText('compute-host reload_mcp failed: boom')).toBeTruthy();
    expect(getMcpChangePending()).toBe(true);
  });

  it('a reload that never answered is reported as unknown, and the banner stays', async () => {
    reloadOutcome = { kind: 'unknown' };
    publishSessionMcpTarget(owner, target(true));
    markMcpChanged();
    await open('/connectors');
    await act(async () => {
      await fireEvent.press(reloadButton());
    });
    await answerAlert('重新加载');
    expect(banner()).toBeTruthy();
    expect(screen.getByText('重新加载时连接中断，结果未确认，请检查连接器状态。')).toBeTruthy();
  });

  it('is disabled with the reason when no chat is connected', async () => {
    markMcpChanged();
    await open('/connectors');
    expect(reloadButton()).toBeDisabled();
    expect(screen.getByText('请先返回会话并等待连接成功，再回来重新加载。')).toBeTruthy();
  });

  it('is disabled with the reason while a turn runs in the chat', async () => {
    publishSessionMcpTarget(owner, { ...target(true), streaming: true });
    markMcpChanged();
    await open('/connectors');
    expect(reloadButton()).toBeDisabled();
    expect(screen.getByText('请等待当前任务结束。')).toBeTruthy();
  });
});

describe('连接器 detail — reload', () => {
  it('a successful switch marks a change as pending', async () => {
    await open('/connectors/server/linear');
    mockSet.mockResolvedValue({ ok: true, name: 'linear', enabled: false });
    await act(async () => fireEvent(screen.getByRole('switch'), 'valueChange', false));
    await flush();
    expect(getMcpChangePending()).toBe(true);
  });

  it('a failed switch does not', async () => {
    await open('/connectors/server/linear');
    mockSet.mockRejectedValue(new HttpError(409, 'Config is locked'));
    await act(async () => fireEvent(screen.getByRole('switch'), 'valueChange', false));
    await flush(30);
    expect(getMcpChangePending()).toBe(false);
  });
});

// --- Sign in and Remove on the detail (plan 3, task 5) -----------------------------------------

describe('连接器 detail — sign in', () => {
  const signInButton = (label = '登录') => screen.getByRole('button', { name: label });
  const pressSignIn = (label = '登录') =>
    act(async () => {
      void fireEvent.press(signInButton(label));
    });

  it('has no sign-in card for a connector that does not use OAuth, or comes from a plugin', async () => {
    await open('/connectors/server/yt');
    expect(screen.queryByRole('button', { name: /^Sign in/ })).toBeNull();
    mockList.mockImplementation(async () => [server({ source: 'plugin', plugin: 'acme' })]);
    await act(async () => router.replace('/connectors/server/linear' as never));
    await flush();
    expect(screen.queryByRole('button', { name: /^Sign in/ })).toBeNull();
  });

  it('says "重新登录" only once a test has seen a token', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    expect(signInButton('登录')).toBeTruthy();
    await act(async () => testCalls[0].resolve({ kind: 'ok', tools: [], prompts: 0, resources: 0, tokensPresent: true }));
    await flush();
    expect(signInButton('重新登录')).toBeTruthy();
  });

  it('approved: shows the tools as a passed test, says Signed in, re-reads the connector and marks a reload as pending', async () => {
    await open('/connectors/server/linear');
    const reads = mockList.mock.calls.length;
    mockSignIn.mockResolvedValue({ kind: 'approved', tools: [{ name: 'search', description: 'Search issues' }] });
    await pressSignIn();
    await flush(20);
    expect(mockSignIn).toHaveBeenCalledWith('linear');
    expect(screen.getByText('连接正常 · 1 个工具')).toBeTruthy();
    expect(screen.getByText('search')).toBeTruthy();
    expect(screen.getByText('已登录。')).toBeTruthy();
    expect(getMcpChangePending()).toBe(true);
    expect(mockList.mock.calls.length).toBe(reads + 1);
  });

  it('a test that was in flight when sign-in started cannot overwrite the sign-in result', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    expect(testCalls).toHaveLength(1); // the automatic test, still pending
    mockSignIn.mockResolvedValue({ kind: 'approved', tools: [] });
    await pressSignIn();
    await flush(20);
    expect(screen.getByText('连接正常 · 0 个工具')).toBeTruthy();
    await act(async () => testCalls[0].resolve({ kind: 'failed', message: 'OLD TEST RESULT', oauthNeeded: true, tokensPresent: false }));
    await flush();
    expect(screen.queryByText('OLD TEST RESULT')).toBeNull();
    expect(screen.getByText('连接正常 · 0 个工具')).toBeTruthy();
  });

  it('a sign-in that fails while a test was in flight leaves Test usable, and shows why', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    expect(screen.getByText('正在测试…')).toBeTruthy();
    mockSignIn.mockResolvedValue({ kind: 'error', message: 'This provider only accepts pre-registered clients.' });
    await pressSignIn();
    await flush(20);
    expect(screen.getByText('This provider only accepts pre-registered clients.')).toBeTruthy();
    expect(screen.queryByText('正在测试…')).toBeNull();
    expect(screen.getByRole('button', { name: '测试连接' })).not.toBeDisabled();
  });

  it('cancelled: says so and runs a test, so a sign-in that did complete still shows', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    await act(async () => testCalls[0].resolve({ kind: 'failed', message: 'no token', oauthNeeded: true, tokensPresent: false }));
    await flush();
    mockSignIn.mockResolvedValue({ kind: 'cancelled' });
    await pressSignIn();
    await flush(20);
    expect(screen.getByText('已取消登录。')).toBeTruthy();
    expect(testCalls).toHaveLength(2);
    expect(getMcpChangePending()).toBe(false);
  });

  it('a connector that is gone: the note, then "未找到连接器" after the re-read', async () => {
    await open('/connectors/server/linear');
    mockSignIn.mockImplementation(async () => {
      mockList.mockImplementation(async () => [local]);
      return { kind: 'error', message: '此连接器已不存在。', gone: true };
    });
    await pressSignIn();
    await flush(30);
    expect(screen.getByText('未找到连接器')).toBeTruthy();
  });

  it('a dead session during sign-in goes to the sign-in screen', async () => {
    await open('/connectors/server/linear');
    mockSignIn.mockRejectedValue(new AuthError('session expired'));
    await pressSignIn();
    await flush(20);
    expect(pathname()).toBe('/');
  });

  it('while a sign-in runs, the switch, Test and Remove are disabled', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    await act(async () => testCalls[0].resolve({ kind: 'ok', tools: [], prompts: 0, resources: 0, tokensPresent: false }));
    await flush();
    let finish!: (o: { kind: 'cancelled' }) => void;
    mockSignIn.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await pressSignIn();
    await flush();
    expect(screen.getByText('等待你在浏览器中完成登录…')).toBeTruthy();
    expect(screen.getByRole('switch').props.disabled).toBe(true);
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '移除连接器' })).toBeDisabled();
    await act(async () => finish({ kind: 'cancelled' }));
    await flush(20);
    expect(screen.getByRole('switch').props.disabled).toBe(false);
  });

  it('opened by an add screen with a sign-in request: starts exactly one sign-in and no automatic test', async () => {
    mockConsume.mockImplementation((name: string) => name === 'linear');
    publishSessionMcpTarget(owner, target(true));
    let finish!: (o: { kind: 'approved'; tools: [] }) => void;
    mockSignIn.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await open('/connectors/server/linear');
    await flush(20);
    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(testCalls).toHaveLength(0);
    await act(async () => finish({ kind: 'approved', tools: [] }));
    await flush(20);
    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(mockConsume).toHaveBeenCalledTimes(1);
  });

  it('without a request it does not start a sign-in by itself', async () => {
    await open('/connectors/server/linear');
    await flush(20);
    expect(mockSignIn).not.toHaveBeenCalled();
  });
});

// Seen on the device (2026-10-01): the provider refused the gateway's redirect address and the
// screen showed its raw JSON, twice.
describe('连接器 detail — a provider that refuses the gateway’s redirect address', () => {
  const RAW =
    'Registration failed: 400 {"error":"invalid_client_metadata","error_description":"redirect_uri is not allowed by the account configuration"}';
  const EXPLAINED =
    '服务器不允许此网关的回调地址，请将其加入允许列表后重新登录。 返回信息：“redirect_uri is not allowed by the account configuration”';
  const OTHER_RAW = 'Registration failed: 403 {"message":"Dynamic registration is disabled"}';
  const NO_TOKEN = { kind: 'failed' as const, message: 'OAuth authentication required — no token found.', oauthNeeded: true, tokensPresent: false };
  const pressTest = () =>
    act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '测试连接' }));
    });
  const pressSignIn = () =>
    act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '登录' }));
    });
  const SUMMARY = '登录尚未配置，服务器不允许此网关的回调地址。';
  const ADDRESS = 'https://hermes.kite-opah.ts.net/api/mcp/oauth/callback/linear';

  beforeEach(() => {
    mockGatewayBase = 'https://hermes.kite-opah.ts.net';
  });

  it('a failed sign-in: the explanation and the address to allow, and none of the provider’s JSON', async () => {
    await open('/connectors/server/linear');
    mockSignIn.mockResolvedValue({ kind: 'error', message: RAW });
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '登录' }));
    });
    await flush(20);
    expect(screen.getByText(EXPLAINED)).toBeTruthy();
    expect(screen.getByText(ADDRESS).props.selectable).toBe(true);
    expect(screen.queryByText(/invalid_client_metadata/)).toBeNull();
  });

  it('a failed test alone: the sign-in card explains it once with the address; the test card has one line', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    await act(async () => testCalls[0].resolve({ kind: 'failed', message: RAW, oauthNeeded: true, tokensPresent: false }));
    await flush();
    expect(screen.getAllByText(EXPLAINED)).toHaveLength(1);
    expect(screen.getAllByText(ADDRESS)).toHaveLength(1);
    expect(screen.getAllByText(SUMMARY)).toHaveLength(1);
    expect(screen.queryByText(/invalid_client_metadata/)).toBeNull();
  });

  it('both failed: still one explanation and one address', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    mockSignIn.mockResolvedValue({ kind: 'error', message: RAW });
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '登录' }));
    });
    await flush(20);
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '测试连接' }));
    });
    await flush();
    await act(async () => testCalls[testCalls.length - 1].resolve({ kind: 'failed', message: RAW, oauthNeeded: true, tokensPresent: false }));
    await flush();
    expect(screen.getAllByText(EXPLAINED)).toHaveLength(1);
    expect(screen.getAllByText(ADDRESS)).toHaveLength(1);
    expect(screen.getAllByText(SUMMARY)).toHaveLength(1);
  });

  it('a connector that cannot sign in here (from a plugin): only the test card’s line, no address', async () => {
    mockList.mockImplementation(async () => [server({ source: 'plugin', plugin: 'acme' })]);
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    await act(async () => testCalls[0].resolve({ kind: 'failed', message: RAW, oauthNeeded: true, tokensPresent: false }));
    await flush();
    expect(screen.getByText(SUMMARY)).toBeTruthy();
    expect(screen.queryByText(ADDRESS)).toBeNull();
  });

  it('a plain-HTTP gateway: says sign-in needs https, and gives no address to allow', async () => {
    mockGatewayBase = 'http://100.64.0.1:9119';
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    await act(async () => testCalls[0].resolve({ kind: 'failed', message: RAW, oauthNeeded: true, tokensPresent: false }));
    await flush();
    expect(screen.getByText('登录需要网关使用 HTTPS 地址，提供商不接受普通 HTTP 回调。')).toBeTruthy();
    expect(screen.queryByText('回调地址')).toBeNull();
    expect(screen.queryByText(/Add it to the server/)).toBeNull();
  });

  it('a refusal for another reason: explained once with the provider’s words, in the sign-in card', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    await act(async () => testCalls[0].resolve({ kind: 'failed', message: OTHER_RAW, oauthNeeded: true, tokensPresent: false }));
    await flush();
    expect(
      screen.getByText('服务器拒绝注册此网关的登录信息（HTTP 403). 返回信息：“Dynamic registration is disabled”'),
    ).toBeTruthy();
    expect(screen.getByText('登录尚未配置，服务器拒绝注册此网关（HTTP 403).')).toBeTruthy();
    expect(screen.getAllByText(/Dynamic registration is disabled/)).toHaveLength(1);
    expect(screen.queryByText('回调地址')).toBeNull();
  });

  it('with no sign-in card (from a plugin), the test card carries the provider’s words itself', async () => {
    mockList.mockImplementation(async () => [server({ source: 'plugin', plugin: 'acme' })]);
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    await act(async () => testCalls[0].resolve({ kind: 'failed', message: OTHER_RAW, oauthNeeded: true, tokensPresent: false }));
    await flush();
    expect(
      screen.getByText('登录尚未配置，服务器拒绝注册此网关（HTTP 403). 返回信息：“Dynamic registration is disabled”'),
    ).toBeTruthy();
  });

  it('a newer test replaces an older sign-in note: a cancelled sign-in does not hide the refusal', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    await act(async () => testCalls[0].resolve(NO_TOKEN));
    await flush();
    mockSignIn.mockResolvedValue({ kind: 'cancelled' });
    await pressSignIn();
    await flush(20);
    expect(screen.getByText('已取消登录。')).toBeTruthy();
    // The cancelled branch runs a test itself; it comes back refused.
    await act(async () => testCalls[testCalls.length - 1].resolve({ kind: 'failed', message: RAW, oauthNeeded: true, tokensPresent: false }));
    await flush();
    expect(screen.getByText(EXPLAINED)).toBeTruthy();
    expect(screen.getByText(ADDRESS)).toBeTruthy();
    expect(screen.queryByText('已取消登录。')).toBeNull();
  });

  it('a refused sign-in, then the allow list is fixed and Test says something else: the old explanation goes', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    mockSignIn.mockResolvedValue({ kind: 'error', message: RAW });
    await pressSignIn();
    await flush(20);
    expect(screen.getByText(EXPLAINED)).toBeTruthy();
    await pressTest();
    await flush();
    // Still there while the test runs: nothing newer is known yet.
    expect(screen.getByText(EXPLAINED)).toBeTruthy();
    await act(async () => testCalls[testCalls.length - 1].resolve(NO_TOKEN));
    await flush();
    expect(screen.queryByText(EXPLAINED)).toBeNull();
    expect(screen.queryByText(ADDRESS)).toBeNull();
    expect(screen.getByText('OAuth authentication required — no token found.')).toBeTruthy();
  });

  it('an info note survives a later test that has nothing to say about sign-in', async () => {
    publishSessionMcpTarget(owner, target(true));
    await open('/connectors/server/linear');
    mockSignIn.mockResolvedValue({ kind: 'approved', tools: [] });
    await pressSignIn();
    await flush(20);
    expect(screen.getByText('已登录。')).toBeTruthy();
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '测试连接' }));
    });
    await flush();
    await act(async () => testCalls[testCalls.length - 1].resolve({ kind: 'ok', tools: [], prompts: 0, resources: 0, tokensPresent: true }));
    await flush();
    expect(screen.getByText('已登录。')).toBeTruthy();
  });
});

describe('连接器 detail — remove', () => {
  const removeButton = () => screen.getByRole('button', { name: '移除连接器' });

  async function pressRemove() {
    await act(async () => {
      await fireEvent.press(removeButton());
    });
  }
  /** Press the alert's button with this label; the alert itself is mocked. */
  async function answerAlert(label: string) {
    const call = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
    const button = (call[2] ?? []).find((b) => b.text === label);
    await act(async () => {
      void button?.onPress?.();
    });
    await flush(20);
  }

  /** The detail on top of the list, as in the app. */
  async function openFromList() {
    await open('/connectors');
    await act(async () => router.push('/connectors/server/linear' as never));
    await flush();
  }

  it('asks first, saying what stays on the gateway; Cancel does nothing', async () => {
    await openFromList();
    await pressRemove();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe('移除 linear?');
    expect(alertSpy.mock.calls[0][1]).toMatch(/仍保留在网关/);
    await answerAlert('取消');
    expect(mockRemove).not.toHaveBeenCalled();
    expect(pathname()).toBe('/connectors/server/linear');
  });

  it('on confirm it removes, marks a reload as pending and goes back to the list', async () => {
    await openFromList();
    mockRemove.mockResolvedValue({ ok: true });
    mockList.mockImplementation(async () => [local]);
    await pressRemove();
    await answerAlert('移除');
    expect(mockRemove).toHaveBeenCalledWith({}, 'linear', null);
    expect(pathname()).toBe('/connectors');
    expect(getMcpChangePending()).toBe(true);
  });

  it('already removed elsewhere (404): goes back to the list as well', async () => {
    await openFromList();
    mockRemove.mockRejectedValue(new HttpError(404, "Server 'linear' not found"));
    await pressRemove();
    await answerAlert('移除');
    expect(pathname()).toBe('/connectors');
  });

  it('a failure shows the gateway reason and stays', async () => {
    await openFromList();
    mockRemove.mockRejectedValue(new HttpError(409, "Server 'linear' is provided by plugin 'acme' and cannot be modified"));
    await pressRemove();
    await answerAlert('移除');
    expect(screen.getByText("Server 'linear' is provided by plugin 'acme' and cannot be modified")).toBeTruthy();
    expect(pathname()).toBe('/connectors/server/linear');
    expect(removeButton()).not.toBeDisabled();
    expect(getMcpChangePending()).toBe(false);
  });

  it('leaving while the removal is out: its late answer does not navigate', async () => {
    await openFromList();
    let finish!: (v: { ok: boolean }) => void;
    mockRemove.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await pressRemove();
    await answerAlert('移除');
    await act(async () => router.dismissTo('/' as never));
    await flush();
    expect(pathname()).toBe('/');
    await act(async () => finish({ ok: true }));
    await flush(20);
    expect(pathname()).toBe('/');
  });

  it('a local or plugin connector has no Remove', async () => {
    await open('/connectors/server/yt');
    expect(screen.queryByRole('button', { name: '移除连接器' })).toBeNull();
  });
});

describe('MCP 连接器 list — the reload note does not outlive the next change', () => {
  it('"已重新加载。" is gone once another change is made', async () => {
    publishSessionMcpTarget(owner, target(true));
    markMcpChanged();
    await open('/connectors');
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: '立即重新加载' }));
    });
    const call = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
    await act(async () => {
      void (call[2] ?? []).find((b) => b.text === '重新加载')?.onPress?.();
    });
    await flush(20);
    expect(screen.getByText('已重新加载。')).toBeTruthy();

    mockSet.mockResolvedValue({ ok: true, name: 'linear', enabled: false });
    await act(async () => fireEvent(screen.getAllByRole('switch')[0], 'valueChange', false));
    await flush();
    expect(screen.getByText('智能体尚未加载你的修改。')).toBeTruthy();
    expect(screen.queryByText('已重新加载。')).toBeNull();
  });

  it('and it is gone when the list regains focus', async () => {
    publishSessionMcpTarget(owner, target(true));
    markMcpChanged();
    await open('/connectors');
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: '立即重新加载' }));
    });
    const call = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
    await act(async () => {
      void (call[2] ?? []).find((b) => b.text === '重新加载')?.onPress?.();
    });
    await flush(20);
    expect(screen.getByText('已重新加载。')).toBeTruthy();
    await act(async () => router.push('/connectors/server/yt' as never));
    await flush();
    await act(async () => router.back());
    await flush();
    expect(screen.queryByText('已重新加载。')).toBeNull();
  });
});

// --- branch review of the add flow and the reload ---------------------------------------------

describe('Branch review: reload and remove against other things happening', () => {
  async function confirmLastAlert(label: string) {
    const call = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
    await act(async () => {
      void (call[2] ?? []).find((b) => b.text === label)?.onPress?.();
    });
  }

  it('a reload does not clear a change made while it was running', async () => {
    let finish!: (o: McpReloadOutcome) => void;
    const t = target(true);
    t.reload = () => new Promise<McpReloadOutcome>((resolve) => (finish = resolve));
    publishSessionMcpTarget(owner, t);
    markMcpChanged();
    await open('/connectors');
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: '立即重新加载' }));
    });
    await confirmLastAlert('重新加载');
    await flush();
    markMcpChanged(); // e.g. a connector removed on its detail while the reload was out
    await act(async () => finish({ kind: 'reloaded', thisChatOnly: false }));
    await flush(20);
    expect(getMcpChangePending()).toBe(true);
    expect(screen.getByText('智能体尚未加载你的修改。')).toBeTruthy();
  });

  it('two presses on 立即重新加载 ask once and reload once', async () => {
    publishSessionMcpTarget(owner, target(true));
    markMcpChanged();
    await open('/connectors');
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', { name: '立即重新加载' }));
      void fireEvent.press(screen.getByRole('button', { name: '立即重新加载' }));
    });
    await flush();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    await confirmLastAlert('重新加载');
    await flush(20);
    expect(reloads).toBe(1);
  });

  it('after Cancel the button asks again', async () => {
    publishSessionMcpTarget(owner, target(true));
    markMcpChanged();
    await open('/connectors');
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: '立即重新加载' }));
    });
    await confirmLastAlert('取消');
    await flush();
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: '立即重新加载' }));
    });
    expect(alertSpy).toHaveBeenCalledTimes(2);
  });

  it('remove: a chat opened on top while it was out stays; the connector is gone when he returns', async () => {
    await open('/connectors');
    await act(async () => router.push('/connectors/server/linear' as never));
    await flush();
    let finish!: (v: { ok: boolean }) => void;
    mockRemove.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: '移除连接器' }));
    });
    await confirmLastAlert('移除');
    await flush();
    await act(async () => router.navigate('/chat/abc' as never));
    await flush();
    mockList.mockImplementation(async () => [local]);
    await act(async () => finish({ ok: true }));
    await flush(20);
    expect(pathname()).toBe('/chat/abc');
    expect(getMcpChangePending()).toBe(true);
    await act(async () => router.back());
    await flush();
    expect(screen.getByText('未找到连接器')).toBeTruthy();
  });

  it('a detail that leaves without having used its sign-in request drops it', async () => {
    await open('/connectors');
    await act(async () => router.push('/connectors/server/yt' as never));
    await flush();
    await act(async () => router.back());
    await flush();
    expect(mockDrop).toHaveBeenCalledWith('yt');
  });
});
