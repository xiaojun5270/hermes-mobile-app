// useConnectorSignIn: the tested sign-in sequence (lib/mcp-oauth) bound to the real browser
// module and REST calls. Here those are mocked; the sequence and the URL check are real.
import { act, renderHook } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import type { McpOauthFlow } from '../src/api/mcp';
import { AuthError, HttpError } from '../src/api/restClient';
import {
  __resetConnectorSignIn,
  consumeSignInRequest,
  requestSignInOnOpen,
  useConnectorSignIn,
} from '../src/components/connector-sign-in';

let mockBaseUrl = 'https://hermes.example.ts.net';
jest.mock('../src/connection', () => ({
  withAuthRetry: (fn: (r: unknown) => Promise<unknown>) => fn({}),
  getRest: () => ({ baseUrl: mockBaseUrl }),
}));

const mockStart = jest.fn();
const mockPoll = jest.fn();
const mockCancel = jest.fn();
jest.mock('../src/api/mcp', () => ({
  ...jest.requireActual('../src/api/mcp'),
  startMcpOauth: (...a: unknown[]) => mockStart(...a),
  getMcpOauthFlow: (...a: unknown[]) => mockPoll(...a),
  cancelMcpOauthFlow: (...a: unknown[]) => mockCancel(...a),
}));

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
  dismissBrowser: jest.fn(async () => ({ type: 'dismiss' })),
}));
const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;
const dismissBrowser = WebBrowser.dismissBrowser as jest.Mock;

const CALLBACK = encodeURIComponent('https://hermes.example.ts.net/api/mcp/oauth/callback/linear');
const AUTH_URL = `https://linear.app/oauth/authorize?state=s1&redirect_uri=${CALLBACK}`;

function flow(over: Partial<McpOauthFlow> = {}): McpOauthFlow {
  return { flow_id: 'f1', server_name: 'linear', status: 'authorization_required', authorization_url: AUTH_URL, error: null, ...over };
}

/** A clock the test controls: every sleep resolves on the next macrotask and advances time. */
function timing() {
  let t = 1_000_000;
  return {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        t += ms;
        setImmediate(resolve);
      }),
    now: () => t,
  };
}

/** Let the sequence run until the given condition holds (bounded). */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) {
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  expect(cond()).toBe(true);
}

let closeBrowser: () => void = () => {};

beforeEach(() => {
  __resetConnectorSignIn();
  mockBaseUrl = 'https://hermes.example.ts.net';
  mockStart.mockReset();
  mockPoll.mockReset();
  mockCancel.mockReset();
  openBrowser.mockReset();
  dismissBrowser.mockClear();
  mockStart.mockResolvedValue(flow());
  mockPoll.mockResolvedValue(flow());
  mockCancel.mockResolvedValue({ ok: true, status: 'error' });
  openBrowser.mockImplementation(
    () =>
      new Promise((resolve) => {
        closeBrowser = () => resolve({ type: 'cancel' });
      }),
  );
  dismissBrowser.mockImplementation(async () => {
    closeBrowser();
    return { type: 'dismiss' };
  });
});

test('refuses on a gateway that is not https, without any request', async () => {
  mockBaseUrl = 'http://100.89.28.11:9119';
  const { result } = await renderHook(() => useConnectorSignIn(null, timing()));
  let outcome: unknown;
  await act(async () => {
    outcome = await result.current.signIn('linear');
  });
  expect(outcome).toEqual({
    kind: 'error',
    message: '登录需要网关使用 HTTPS 地址，提供商不接受普通 HTTP 回调。',
  });
  expect(mockStart).not.toHaveBeenCalled();
  expect(openBrowser).not.toHaveBeenCalled();
});

test('the approved path: opens the page, returns the tools, closes the page and clears the phase', async () => {
  mockPoll.mockResolvedValueOnce(flow()).mockResolvedValue(flow({ status: 'approved', tools: [{ name: 'search', description: '搜索会话' }] }));
  const t = timing();
  const { result } = await renderHook(() => useConnectorSignIn('work', t));
  let outcome: unknown;
  await act(async () => {
    outcome = await result.current.signIn('linear');
  });
  expect(outcome).toEqual({ kind: 'approved', tools: [{ name: 'search', description: '搜索会话' }] });
  expect(mockStart).toHaveBeenCalledWith({}, 'linear', 'work');
  expect(openBrowser).toHaveBeenCalledWith(AUTH_URL, expect.anything());
  expect(dismissBrowser).toHaveBeenCalled();
  expect(mockCancel).not.toHaveBeenCalled();
  expect(result.current.phase).toBeNull();
});

test('shows the phase while it runs; cancel() ends it as cancelled and cancels the flow on the gateway', async () => {
  const t = timing();
  const { result } = await renderHook(() => useConnectorSignIn(null, t));
  let outcome: unknown;
  let done = false;
  await act(async () => {
    void result.current.signIn('linear').then((o) => {
      outcome = o;
      done = true;
    });
  });
  await until(() => result.current.phase === 'browser');
  // Hold the gateway's answer to the cancel, so the "cancelling" state can be seen.
  let release!: () => void;
  mockCancel.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ ok: true, status: 'error' }))));
  await act(async () => result.current.cancel());
  await until(() => mockCancel.mock.calls.length === 1);
  expect(result.current.cancelling).toBe(true);
  expect(done).toBe(false);
  await act(async () => release());
  await until(() => done);
  expect(outcome).toEqual({ kind: 'cancelled' });
  expect(mockCancel).toHaveBeenCalledWith({}, 'f1');
  expect(result.current.phase).toBeNull();
  expect(result.current.cancelling).toBe(false);
});

test('leaving the screen cancels the flow and closes the page', async () => {
  const t = timing();
  const { result, unmount } = await renderHook(() => useConnectorSignIn(null, t));
  let done = false;
  await act(async () => {
    void result.current.signIn('linear').then(() => {
      done = true;
    });
  });
  await until(() => openBrowser.mock.calls.length === 1);
  await unmount();
  await until(() => done);
  expect(mockCancel).toHaveBeenCalledWith({}, 'f1');
  expect(dismissBrowser).toHaveBeenCalled();
});

test('a second sign-in while one runs is refused, and is not reported as cancelled', async () => {
  const t = timing();
  const { result } = await renderHook(() => useConnectorSignIn(null, t));
  let first = false;
  await act(async () => {
    void result.current.signIn('linear').then(() => {
      first = true;
    });
  });
  await until(() => openBrowser.mock.calls.length === 1);
  let second: unknown;
  await act(async () => {
    second = await result.current.signIn('linear');
  });
  expect(second).toEqual({ kind: 'error', message: '已有登录流程正在进行。' });
  expect(mockStart).toHaveBeenCalledTimes(1);
  await act(async () => result.current.cancel());
  await until(() => first);
});

test('retries a 409 once after its own recent cancel — even from a new screen instance', async () => {
  const t = timing();
  const one = await renderHook(() => useConnectorSignIn(null, t));
  let done = false;
  await act(async () => {
    void one.result.current.signIn('linear').then(() => {
      done = true;
    });
  });
  await until(() => openBrowser.mock.calls.length === 1);
  await act(async () => one.result.current.cancel());
  await until(() => done);
  await one.unmount();

  mockStart.mockReset();
  mockStart.mockRejectedValueOnce(new HttpError(409, "MCP OAuth for 'linear' is already in progress")).mockResolvedValue(flow());
  mockPoll.mockResolvedValue(flow({ status: 'approved', tools: [] }));
  const two = await renderHook(() => useConnectorSignIn(null, t));
  let outcome: { kind: string } | undefined;
  await act(async () => {
    outcome = await two.result.current.signIn('linear');
  });
  expect(mockStart).toHaveBeenCalledTimes(2);
  expect(outcome?.kind).toBe('approved');
});

test('without a recent cancel a 409 is reported, not retried', async () => {
  mockStart.mockRejectedValue(new HttpError(409, "MCP OAuth for 'linear' is already in progress"));
  const { result } = await renderHook(() => useConnectorSignIn(null, timing()));
  let outcome: unknown;
  await act(async () => {
    outcome = await result.current.signIn('linear');
  });
  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(outcome).toEqual({ kind: 'error', message: "MCP OAuth for 'linear' is already in progress" });
});

test('a dead session rejects with AuthError and clears the phase', async () => {
  mockStart.mockRejectedValue(new AuthError('session expired'));
  const { result } = await renderHook(() => useConnectorSignIn(null, timing()));
  let error: unknown;
  await act(async () => {
    error = await result.current.signIn('linear').catch((e) => e);
  });
  expect(error).toBeInstanceOf(AuthError);
  expect(result.current.phase).toBeNull();
});

test('a redirect that does not come back to this gateway is not opened, and the flow is cancelled', async () => {
  const elsewhere = encodeURIComponent('http://127.0.0.1:9119/api/mcp/oauth/callback/linear');
  mockStart.mockResolvedValue(flow({ authorization_url: `https://linear.app/oauth/authorize?state=s1&redirect_uri=${elsewhere}` }));
  const { result } = await renderHook(() => useConnectorSignIn(null, timing()));
  let outcome: { kind: string; message?: string } | undefined;
  await act(async () => {
    outcome = await result.current.signIn('linear');
  });
  expect(outcome?.kind).toBe('error');
  expect(outcome?.message).toMatch(/HERMES_DASHBOARD_PUBLIC_URL/);
  expect(openBrowser).not.toHaveBeenCalled();
  expect(mockCancel).toHaveBeenCalledWith({}, 'f1');
});

test('an open that answers `locked` is a failure to open', async () => {
  openBrowser.mockResolvedValue({ type: 'locked' });
  const { result } = await renderHook(() => useConnectorSignIn(null, timing()));
  let outcome: unknown;
  await act(async () => {
    outcome = await result.current.signIn('linear');
  });
  expect(outcome).toEqual({ kind: 'error', message: '无法打开登录页面。' });
  expect(mockCancel).toHaveBeenCalledWith({}, 'f1');
});

test('the "sign in on open" intent is one-shot and per connector', () => {
  expect(consumeSignInRequest('linear')).toBe(false);
  requestSignInOnOpen('linear');
  expect(consumeSignInRequest('figma')).toBe(false);
  expect(consumeSignInRequest('linear')).toBe(true);
  expect(consumeSignInRequest('linear')).toBe(false);
});
