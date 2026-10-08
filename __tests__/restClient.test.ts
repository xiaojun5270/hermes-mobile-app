// __tests__/restClient.test.ts
import {
  RestClient,
  AuthError,
  AT_FRESH_MARGIN_MS,
  MAX_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  resolveTimeoutMs,
} from '../src/api/restClient';
import { CookieJar } from '../src/api/cookieJar';

function fakeFetch(status: number, body: unknown, setCookie?: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k: string) => (k.toLowerCase() === 'set-cookie' ? setCookie ?? null : null) },
      json: async () => body,
    } as unknown as Response;
  };
  return Object.assign(fn, { calls });
}

describe('RestClient', () => {
  it('login posts credentials and ingests cookies', async () => {
    const jar = new CookieJar();
    const f = fakeFetch(200, { ok: true }, 'hermes_session_at=tok; Max-Age=900; Path=/');
    const c = new RestClient('http://100.1.2.3:9119', jar, f as any);
    await c.login('gianluca', 'pw');
    expect(f.calls[0].url).toBe('http://100.1.2.3:9119/auth/password-login');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({
      provider: 'basic', username: 'gianluca', password: 'pw',
    });
    expect(jar.header()).toBe('hermes_session_at=tok');
  });

  it('login throws AuthError on 401', async () => {
    const c = new RestClient('http://h', new CookieJar(), fakeFetch(401, { detail: 'Invalid credentials' }) as any);
    await expect(c.login('u', 'bad')).rejects.toThrow(AuthError);
  });

  it('authed requests send the Cookie header and ingest rotations', async () => {
    const jar = new CookieJar();
    jar.ingest(['hermes_session_rt=r1; Path=/']);
    const f = fakeFetch(200, { ticket: 't', ttl_seconds: 30 }, 'hermes_session_rt=r2; Path=/');
    const c = new RestClient('http://h', jar, f as any);
    const t = await c.wsTicket();
    expect(t.ticket).toBe('t');
    expect((f.calls[0].init.headers as Record<string, string>)['Cookie']).toBe('hermes_session_rt=r1');
    expect(jar.header()).toBe('hermes_session_rt=r2'); // rotation honored
  });

  it('authed requests throw AuthError on 401 (session dead → re-login)', async () => {
    const c = new RestClient('http://h', new CookieJar(), fakeFetch(401, {}) as any);
    await expect(c.listSessions()).rejects.toThrow(AuthError);
  });

  it('surfaces FastAPI {detail} on non-ok responses (e.g. cron schedule-parse 400s)', async () => {
    const c = new RestClient(
      'http://h',
      new CookieJar(),
      fakeFetch(400, { detail: 'Could not parse schedule: "every blarg"' }) as any,
    );
    await expect(c.get('/api/cron/jobs')).rejects.toThrow('Could not parse schedule: "every blarg"');
  });

  it('falls back to a generic message when the error body has no detail', async () => {
    const c = new RestClient('http://h', new CookieJar(), fakeFetch(500, { nope: 1 }) as any);
    await expect(c.get('/api/x')).rejects.toThrow('请求 /api/x 失败（HTTP 500）');
  });

  it('listSessions hits the right URL', async () => {
    const f = fakeFetch(200, { sessions: [], total: 0, limit: 40, offset: 0 });
    const c = new RestClient('http://h', new CookieJar(), f as any);
    await c.listSessions();
    expect(f.calls[0].url).toBe('http://h/api/sessions?limit=40&offset=0&order=recent');
  });

  it('listSessions paginates via offset', async () => {
    const f = fakeFetch(200, { sessions: [], total: 90, limit: 40, offset: 40 });
    const c = new RestClient('http://h', new CookieJar(), f as any);
    await c.listSessions(40);
    expect(f.calls[0].url).toBe('http://h/api/sessions?limit=40&offset=40&order=recent');
  });
});

describe('RestClient single-flight (rotating-token race)', () => {
  // Minimal Response stub matching the transport's needs.
  const res = (status: number, body: unknown, setCookie?: string) =>
    ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k: string) => (k.toLowerCase() === 'set-cookie' ? setCookie ?? null : null) },
      json: async () => body,
    }) as unknown as Response;

  it('serializes concurrent authed requests so the second sends the rotated cookie', async () => {
    const jar = new CookieJar();
    jar.ingest(['hermes_session_rt=r1; Path=/']);

    const seen: string[] = [];
    let call = 0;
    // The first request is slow and rotates r1→r2. If requests are NOT
    // serialized, the second reads the jar before that rotation is ingested
    // and ALSO sends r1 — exactly the rotated-out replay the gateway treats
    // as reuse and revokes the device for.
    const fetchFn = async (_url: string, init: RequestInit = {}) => {
      const i = call++;
      seen[i] = (init.headers as Record<string, string>)['Cookie'] ?? '';
      if (i === 0) {
        await new Promise((r) => setTimeout(r, 20));
        return res(200, { ok: true }, 'hermes_session_rt=r2; Path=/');
      }
      return res(200, { ok: true });
    };
    const c = new RestClient('http://h', jar, fetchFn as any);
    await Promise.all([c.get('/a'), c.get('/b')]);

    expect(seen[0]).toBe('hermes_session_rt=r1');
    expect(seen[1]).toBe('hermes_session_rt=r2'); // waited for the rotation
  });

  it('a failed request does not poison the chain for later requests', async () => {
    const jar = new CookieJar();
    let call = 0;
    const fetchFn = async () => (call++ === 0 ? res(500, { nope: 1 }) : res(200, { ok: true }));
    const c = new RestClient('http://h', jar, fetchFn as any);
    await expect(c.get('/a')).rejects.toThrow();
    await expect(c.get('/b')).resolves.toEqual({ ok: true });
  });
});

describe('RestClient expiry-aware serialization', () => {
  const res = (status: number, body: unknown, setCookie?: string) =>
    ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k: string) => (k.toLowerCase() === 'set-cookie' ? setCookie ?? null : null) },
      json: async () => body,
    }) as unknown as Response;

  it('runs requests concurrently while the access token is fresh', async () => {
    const NOW = 1_000_000;
    const jar = new CookieJar(() => NOW);
    jar.ingest(['hermes_session_at=at; Max-Age=900; Path=/', 'hermes_session_rt=r1; Path=/']);

    // The first request blocks on a gate the test controls — deterministic, no
    // real timers. If requests were serialized, the second would never start
    // until the gate releases; concurrent dispatch lets it run immediately.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let secondStarted = false;
    let call = 0;
    const fetchFn = async () => {
      const i = call++;
      if (i === 0) {
        await firstGate;
        return res(200, { ok: true });
      }
      secondStarted = true;
      return res(200, { ok: true });
    };
    const c = new RestClient('http://h', jar, fetchFn as any);
    const all = Promise.all([c.get('/a'), c.get('/b')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(secondStarted).toBe(true); // ran without waiting for the gated first
    releaseFirst();
    await all;
  });

  it('still ingests Set-Cookie rotations on the concurrent (fresh) path', async () => {
    const NOW = 1_000_000;
    const jar = new CookieJar(() => NOW);
    jar.ingest(['hermes_session_at=at; Max-Age=900; Path=/', 'hermes_session_rt=r1; Path=/']);
    const fetchFn = async () => res(200, { ok: true }, 'hermes_session_rt=r2; Path=/');
    const c = new RestClient('http://h', jar, fetchFn as any);
    await c.get('/a');
    expect(jar.header()).toContain('hermes_session_rt=r2');
  });

  it('serializes requests when the access token is within the refresh margin', async () => {
    const NOW = 1_000_000;
    const jar = new CookieJar(() => NOW);
    // 30s of AT life left — inside AT_FRESH_MARGIN_MS → treated as stale.
    jar.ingest(['hermes_session_at=at; Max-Age=30; Path=/', 'hermes_session_rt=r1; Path=/']);

    const seen: string[] = [];
    let call = 0;
    const fetchFn = async (_url: string, init: RequestInit = {}) => {
      const i = call++;
      seen[i] = (init.headers as Record<string, string>)['Cookie'] ?? '';
      if (i === 0) {
        await new Promise((r) => setTimeout(r, 20));
        return res(200, { ok: true }, 'hermes_session_rt=r2; Path=/');
      }
      return res(200, { ok: true });
    };
    const c = new RestClient('http://h', jar, fetchFn as any);
    await Promise.all([c.get('/a'), c.get('/b')]);
    expect(seen[0]).toContain('hermes_session_rt=r1');
    expect(seen[1]).toContain('hermes_session_rt=r2'); // 2nd waited for the rotation
  });
});

describe('listSessions archived', () => {
  it('appends archived=only and keeps the default URL unchanged otherwise', async () => {
    const f = fakeFetch(200, { sessions: [], total: 0, limit: 40, offset: 0 });
    const c = new RestClient('http://h', new CookieJar(), f as any);
    await c.listSessions(0, 'only');
    await c.listSessions(0);
    expect(f.calls[0].url).toBe('http://h/api/sessions?limit=40&offset=0&order=recent&archived=only');
    expect(f.calls[1].url).toBe('http://h/api/sessions?limit=40&offset=0&order=recent');
  });
});

describe('RestClient request timeout', () => {
  const abortError = () => {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  };

  it('aborts a request that hangs in the headers phase', async () => {
    jest.useFakeTimers();
    try {
      const jar = new CookieJar(() => 1_000_000);
      jar.ingest(['hermes_session_at=at; Max-Age=900; Path=/']); // fresh → direct send

      let captured: AbortSignal | undefined;
      const hang = (_url: string, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          captured = init.signal as AbortSignal | undefined;
          captured?.addEventListener('abort', () => reject(abortError()));
        });
      const c = new RestClient('http://h', jar, hang as any);
      const p = c.get('/slow');
      p.catch(() => {}); // attach early so the rejection is never "unhandled"
      await Promise.resolve(); // let send() install the timer + abort listener
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      expect(captured?.aborted).toBe(true); // fails fast if the timer never fired
      await expect(p).rejects.toThrow('请求超时（20 秒）');
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out when the response body stalls after headers arrive', async () => {
    jest.useFakeTimers();
    try {
      const jar = new CookieJar(() => 1_000_000);
      jar.ingest(['hermes_session_at=at; Max-Age=900; Path=/']);

      // Headers arrive immediately; res.json() hangs until aborted — the timer
      // must still cover the body read, or this would freeze forever.
      const stallBody = (_url: string, init: RequestInit = {}) => {
        const signal = init.signal as AbortSignal | undefined;
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: { get: () => null },
          json: () =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(abortError()));
            }),
        } as unknown as Response);
      };
      const c = new RestClient('http://h', jar, stallBody as any);
      const p = c.get('/slow-body');
      p.catch(() => {});
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      await expect(p).rejects.toThrow('请求超时（20 秒）');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('RestClient fresh-path race invariant', () => {
  it('keeps the AT freshness margin dominating the request timeout', () => {
    expect(AT_FRESH_MARGIN_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
  });
});

describe('RestClient durable rotation persistence', () => {
  it('awaits cookie persistence before resolving when a response rotated the RT', async () => {
    const jar = new CookieJar();
    jar.ingest(['hermes_session_rt=r1; Path=/']);

    let releasePersist!: () => void;
    let persistCalls = 0;
    const persisted = new Promise<void>((r) => {
      releasePersist = r;
    });
    const flush = () => {
      persistCalls++;
      return persisted;
    };
    const f = fakeFetch(200, { ok: true }, 'hermes_session_rt=r2; Path=/');
    const c = new RestClient('http://h', jar, f as any, flush);

    let resolved = false;
    const p = c.get('/a').then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks

    expect(persistCalls).toBe(1); // persistence invoked after the rotation
    expect(resolved).toBe(false); // request blocked on durable persistence
    expect(jar.header()).toBe('hermes_session_rt=r2'); // rotation already ingested in-memory

    releasePersist();
    await p;
    expect(resolved).toBe(true);
  });

  it('does not await persistence when a response carries no Set-Cookie', async () => {
    const jar = new CookieJar();
    let persistCalls = 0;
    const flush = () => {
      persistCalls++;
      return Promise.resolve();
    };
    const f = fakeFetch(200, { ok: true }); // no rotation
    const c = new RestClient('http://h', jar, f as any, flush);
    await c.get('/a');
    expect(persistCalls).toBe(0);
  });

  it('still resolves the request when persistence rejects (best-effort)', async () => {
    const jar = new CookieJar();
    jar.ingest(['hermes_session_rt=r1; Path=/']);
    const flush = () => Promise.reject(new Error('keychain busy'));
    const f = fakeFetch(200, { ok: true }, 'hermes_session_rt=r2; Path=/');
    const c = new RestClient('http://h', jar, f as any, flush);
    await expect(c.get('/a')).resolves.toEqual({ ok: true });
    expect(jar.header()).toBe('hermes_session_rt=r2');
  });
});

describe('RestClient per-request timeout', () => {
  const abortError = () => {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  };

  /** A client whose fetch never answers; `signal()` is the request's abort signal. */
  function hangingClient() {
    const jar = new CookieJar(() => 1_000_000);
    jar.ingest(['hermes_session_at=at; Max-Age=900; Path=/']); // fresh → direct send
    let captured: AbortSignal | undefined;
    const hang = (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        captured = init.signal as AbortSignal | undefined;
        captured?.addEventListener('abort', () => reject(abortError()));
      });
    return { c: new RestClient('http://h', jar, hang as any), signal: () => captured };
  }

  it('a longer limit outlives the default and fires at its own limit', async () => {
    jest.useFakeTimers();
    try {
      const { c, signal } = hangingClient();
      const p = c.post('/slow', {}, { timeoutMs: 45_000 });
      p.catch(() => {});
      await Promise.resolve();
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      expect(signal()?.aborted).toBe(false);
      jest.advanceTimersByTime(45_000 - REQUEST_TIMEOUT_MS);
      expect(signal()?.aborted).toBe(true);
      await expect(p).rejects.toThrow('请求超时（45 秒）');
    } finally {
      jest.useRealTimers();
    }
  });

  it('honours the longer limit on the chained path too (token expiry unknown)', async () => {
    jest.useFakeTimers();
    try {
      let captured: AbortSignal | undefined;
      const hang = (_url: string, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          captured = init.signal as AbortSignal | undefined;
          captured?.addEventListener('abort', () => reject(abortError()));
        });
      const c = new RestClient('http://h', new CookieJar(), hang as any); // no AT seen → chained
      const p = c.post('/slow', {}, { timeoutMs: 45_000 });
      p.catch(() => {});
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      expect(captured?.aborted).toBe(false);
      jest.advanceTimersByTime(45_000 - REQUEST_TIMEOUT_MS);
      expect(captured?.aborted).toBe(true);
      await expect(p).rejects.toThrow('请求超时（45 秒）');
    } finally {
      jest.useRealTimers();
    }
  });

  it('clamps a limit above the ceiling', async () => {
    jest.useFakeTimers();
    try {
      const { c, signal } = hangingClient();
      const p = c.get('/slow', { timeoutMs: 600_000 });
      p.catch(() => {});
      await Promise.resolve();
      jest.advanceTimersByTime(MAX_REQUEST_TIMEOUT_MS);
      expect(signal()?.aborted).toBe(true);
      await expect(p).rejects.toThrow('请求超时（45 秒）');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the default limit and message when no option is passed', async () => {
    jest.useFakeTimers();
    try {
      const { c } = hangingClient();
      const p = c.del('/slow');
      p.catch(() => {});
      await Promise.resolve();
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      await expect(p).rejects.toThrow('请求超时（20 秒）');
    } finally {
      jest.useRealTimers();
    }
  });

  it('resolveTimeoutMs ignores values that are not a positive finite number', () => {
    expect(resolveTimeoutMs()).toBe(REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs({})).toBe(REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs({ timeoutMs: 0 })).toBe(REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs({ timeoutMs: -5 })).toBe(REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs({ timeoutMs: Number.NaN })).toBe(REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs({ timeoutMs: Number.POSITIVE_INFINITY })).toBe(REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs({ timeoutMs: 30_000 })).toBe(30_000);
    expect(resolveTimeoutMs({ timeoutMs: 90_000 })).toBe(MAX_REQUEST_TIMEOUT_MS);
  });

  it('keeps the AT freshness margin above the ceiling', () => {
    expect(AT_FRESH_MARGIN_MS).toBeGreaterThan(MAX_REQUEST_TIMEOUT_MS);
    expect(MAX_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(REQUEST_TIMEOUT_MS);
  });
});
