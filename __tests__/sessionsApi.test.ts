// __tests__/sessionsApi.test.ts
import { CookieJar } from '../src/api/cookieJar';
import { RestClient } from '../src/api/restClient';
import { deleteSession, renameSession } from '../src/api/sessions';

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

describe('RestClient.patch', () => {
  it('sends a PATCH with a JSON body and cookies', async () => {
    const jar = new CookieJar();
    jar.ingest(['hermes_session_at=tok; Path=/']);
    const f = fakeFetch(200, { ok: true });
    const c = new RestClient('http://h', jar, f as any);
    await c.patch('/api/sessions/abc', { title: 'New' });
    expect(f.calls[0].url).toBe('http://h/api/sessions/abc');
    expect(f.calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ title: 'New' });
    expect((f.calls[0].init.headers as Record<string, string>)['Cookie']).toBe('hermes_session_at=tok');
  });
});

describe('renameSession', () => {
  it('PATCHes the session with the new title', async () => {
    const f = fakeFetch(200, { ok: true, title: 'Renamed' });
    const c = new RestClient('http://h', new CookieJar(), f as any);
    const res = await renameSession(c, 'abc123', 'Renamed');
    expect(res).toEqual({ ok: true, title: 'Renamed' });
    expect(f.calls[0].url).toBe('http://h/api/sessions/abc123');
    expect(f.calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ title: 'Renamed' });
  });

  it('sends an empty title to clear it (contract semantics)', async () => {
    const f = fakeFetch(200, { ok: true, title: '' });
    const c = new RestClient('http://h', new CookieJar(), f as any);
    await renameSession(c, 'abc', '');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ title: '' });
  });

  it('URL-encodes the session id', async () => {
    const f = fakeFetch(200, { ok: true, title: 'x' });
    const c = new RestClient('http://h', new CookieJar(), f as any);
    await renameSession(c, 'a/b c', 'x');
    expect(f.calls[0].url).toBe('http://h/api/sessions/a%2Fb%20c');
  });

  it('surfaces HTTP errors (400 invalid title)', async () => {
    const f = fakeFetch(400, { detail: 'Title already in use' });
    const c = new RestClient('http://h', new CookieJar(), f as any);
    await expect(renameSession(c, 'abc', 'dupe')).rejects.toThrow('Title already in use');
  });
});

describe('deleteSession', () => {
  it('DELETEs the session by id', async () => {
    const f = fakeFetch(200, { ok: true });
    const c = new RestClient('http://h', new CookieJar(), f as any);
    const res = await deleteSession(c, 'abc123');
    expect(res).toEqual({ ok: true });
    expect(f.calls[0].url).toBe('http://h/api/sessions/abc123');
    expect(f.calls[0].init.method).toBe('DELETE');
  });

  it('surfaces a 404 for unknown sessions', async () => {
    const f = fakeFetch(404, { detail: 'Not found' });
    const c = new RestClient('http://h', new CookieJar(), f as any);
    await expect(deleteSession(c, 'missing')).rejects.toThrow('Not found');
  });
});

describe('setSession已归档', () => {
  it('PATCHes archived true/false with optional profile', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const client = { patch: async (path: string, body: unknown) => { calls.push({ path, body }); return { ok: true, archived: true }; } };
    const { setSessionArchived } = require('../src/api/sessions');
    await setSessionArchived(client as any, 'abc', true);
    await setSessionArchived(client as any, 'abc', false, 'work');
    expect(calls[0]).toEqual({ path: '/api/sessions/abc', body: { archived: true } });
    expect(calls[1]).toEqual({ path: '/api/sessions/abc', body: { archived: false, profile: 'work' } });
  });
});
