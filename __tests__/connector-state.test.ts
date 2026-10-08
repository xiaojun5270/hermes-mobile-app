// __tests__/connector-state.test.ts
import {
  SIGN_IN_REQUEST_TTL_MS,
  clearMcpChanged,
  consumeSignInRequest,
  dropSignInRequest,
  getMcpChangePending,
  lastSignInCancel,
  markMcpChanged,
  mcpChangeMark,
  noteSignInCancelled,
  requestSignInOnOpen,
  resetConnectorState,
  subscribeMcpChange,
} from '../src/connector-state';

beforeEach(() => resetConnectorState());

describe('change-pending flag', () => {
  it('starts clear, is set by a change and cleared by a reload', () => {
    expect(getMcpChangePending()).toBe(false);
    markMcpChanged();
    expect(getMcpChangePending()).toBe(true);
    clearMcpChanged();
    expect(getMcpChangePending()).toBe(false);
  });

  it('a reload clears only the changes that existed when it started', () => {
    markMcpChanged();
    const mark = mcpChangeMark(); // read by the screen just before reload.mcp
    markMcpChanged(); // a connector removed while the reload was running
    clearMcpChanged(mark);
    expect(getMcpChangePending()).toBe(true);
    clearMcpChanged(mcpChangeMark());
    expect(getMcpChangePending()).toBe(false);
  });

  it('notifies only when the value changes', () => {
    let n = 0;
    const unsub = subscribeMcpChange(() => {
      n++;
    });
    markMcpChanged();
    markMcpChanged();
    expect(n).toBe(1);
    clearMcpChanged();
    clearMcpChanged();
    expect(n).toBe(2);
    unsub();
    markMcpChanged();
    expect(n).toBe(2);
  });
});

describe('"sign in when the detail opens" request', () => {
  it('is one-shot and per connector', () => {
    expect(consumeSignInRequest('linear', 0)).toBe(false);
    requestSignInOnOpen('linear', 1_000);
    expect(consumeSignInRequest('figma', 1_500)).toBe(false);
    expect(consumeSignInRequest('linear', 1_500)).toBe(true);
    expect(consumeSignInRequest('linear', 1_600)).toBe(false);
  });

  it('expires: a detail that could not use it must not start a sign-in on a later visit', () => {
    requestSignInOnOpen('linear', 1_000);
    expect(consumeSignInRequest('linear', 1_000 + SIGN_IN_REQUEST_TTL_MS + 1)).toBe(false);
    // and it is gone, not merely skipped once
    expect(consumeSignInRequest('linear', 1_500)).toBe(false);
  });

  it('can be dropped by the detail it was meant for, and only by that one', () => {
    requestSignInOnOpen('linear', 1_000);
    dropSignInRequest('figma');
    expect(consumeSignInRequest('linear', 1_100)).toBe(true);
    requestSignInOnOpen('linear', 2_000);
    dropSignInRequest('linear');
    expect(consumeSignInRequest('linear', 2_100)).toBe(false);
  });
});

describe('last cancelled sign-in, per connector', () => {
  it('remembers when this app cancelled a flow', () => {
    expect(lastSignInCancel('linear')).toBeUndefined();
    noteSignInCancelled('linear', 5_000);
    expect(lastSignInCancel('linear')).toBe(5_000);
    expect(lastSignInCancel('figma')).toBeUndefined();
  });
});

describe('reset连接器State (a different gateway, or a disconnect)', () => {
  it('forgets everything that belonged to the previous gateway', () => {
    let n = 0;
    subscribeMcpChange(() => {
      n++;
    });
    markMcpChanged();
    requestSignInOnOpen('linear', 1_000);
    noteSignInCancelled('linear', 1_000);
    resetConnectorState();
    expect(getMcpChangePending()).toBe(false);
    expect(n).toBe(2); // subscribers are told, and stay subscribed
    expect(consumeSignInRequest('linear', 1_100)).toBe(false);
    expect(lastSignInCancel('linear')).toBeUndefined();
  });
});
