// __tests__/storedConnection.test.ts
import {
  StoredConnectionError,
  StoredConnectionV2,
  migrateStoredConnection,
} from '../src/lib/stored-connection';

describe('migrateStored连接', () => {
  it('migrates a v1 (M1 password) blob to v2 password mode', () => {
    const v1 = JSON.stringify({
      baseUrl: 'http://100.64.0.7:9119',
      username: 'gldc',
      password: 'hunter2',
      cookies: { hermes_session_rt: 'rt1' },
    });
    expect(migrateStoredConnection(v1)).toEqual({
      version: 2,
      baseUrl: 'http://100.64.0.7:9119',
      mode: 'password',
      username: 'gldc',
      password: 'hunter2',
      deviceId: undefined,
      cookies: { hermes_session_rt: 'rt1' },
    } satisfies StoredConnectionV2);
  });

  it('passes a v2 device blob through unchanged', () => {
    const v2: StoredConnectionV2 = {
      version: 2,
      baseUrl: 'http://100.64.0.7:9119',
      mode: 'device',
      deviceId: 'a1b2c3d4e5f60718',
      cookies: { hermes_session_rt: 'rt2', hermes_session_at: 'at2' },
    };
    expect(migrateStoredConnection(JSON.stringify(v2))).toEqual({
      ...v2,
      username: undefined,
      password: undefined,
    });
  });

  it('passes a v2 password blob through unchanged', () => {
    const v2: StoredConnectionV2 = {
      version: 2,
      baseUrl: 'http://gw:9119',
      mode: 'password',
      username: 'u',
      password: 'p',
      cookies: {},
    };
    expect(migrateStoredConnection(JSON.stringify(v2))).toEqual({ ...v2, deviceId: undefined });
  });

  it('defaults a v2 blob with an unknown mode to password (fail-safe)', () => {
    const blob = JSON.stringify({ version: 2, baseUrl: 'http://gw', mode: 'oauth', cookies: {} });
    expect(migrateStoredConnection(blob).mode).toBe('password');
  });

  it('tolerates a v1 blob with missing/garbage cookies', () => {
    const blob = JSON.stringify({ baseUrl: 'http://gw', username: 'u', password: 'p', cookies: 7 });
    expect(migrateStoredConnection(blob).cookies).toEqual({});
  });

  it.each([
    ['not JSON', '{{nope'],
    ['JSON array', '[]'],
    ['missing baseUrl', JSON.stringify({ username: 'u', password: 'p', cookies: {} })],
    ['empty baseUrl', JSON.stringify({ baseUrl: '', username: 'u', password: 'p' })],
    ['v1 without credentials', JSON.stringify({ baseUrl: 'http://gw', cookies: {} })],
  ])('throws Stored连接Error on %s', (_name, raw) => {
    expect(() => migrateStoredConnection(raw)).toThrow(StoredConnectionError);
  });
});
