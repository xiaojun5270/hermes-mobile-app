// __tests__/memory.test.ts
import {
  BUILT_IN_PROVIDER,
  MEMORY_FILE_MAX_BYTES,
  formatBytes,
  getMemoryStatus,
  isMemoryFileName,
  isMemoryPluginMissing,
  listMemoryFiles,
  memoryFileLabel,
  memoryFileTooLarge,
  memoryWriteErrorMessage,
  providerLabel,
  readMemoryFile,
  resetMemory,
  setMemoryProvider,
  utf8ByteLength,
  writeMemoryFile,
} from '../src/api/memory';
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

describe('memory api', () => {
  it('getMemoryStatus hits GET /api/memory and returns the status shape', async () => {
    const f = fakeFetch(200, {
      active: '',
      providers: [{ name: 'mem0', description: 'Mem0 memory', configured: true }],
      builtin_files: { memory: 1234, user: 0 },
    });
    const s = await getMemoryStatus(client(f));
    expect(f.calls[0].url).toBe('http://h/api/memory');
    expect(f.calls[0].init.method).toBeUndefined(); // GET
    expect(s.active).toBe(BUILT_IN_PROVIDER);
    expect(s.providers[0].name).toBe('mem0');
    expect(s.builtin_files).toEqual({ memory: 1234, user: 0 });
  });

  it('setMemoryProvider PUTs the provider name', async () => {
    const f = fakeFetch(200, { ok: true, active: 'mem0' });
    const res = await setMemoryProvider(client(f), 'mem0');
    expect(f.calls[0].url).toBe('http://h/api/memory/provider');
    expect(f.calls[0].init.method).toBe('PUT');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ provider: 'mem0' });
    expect(res.active).toBe('mem0');
  });

  it('setMemoryProvider sends "" to select the built-in backend', async () => {
    const f = fakeFetch(200, { ok: true, active: '' });
    await setMemoryProvider(client(f), BUILT_IN_PROVIDER);
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ provider: '' });
  });

  it('setMemoryProvider surfaces 400 for unknown providers', async () => {
    const f = fakeFetch(400, { detail: 'unknown provider' });
    await expect(setMemoryProvider(client(f), 'nope')).rejects.toThrow('unknown provider');
  });

  it('resetMemory POSTs the target', async () => {
    const f = fakeFetch(200, { ok: true, deleted: ['MEMORY.md'] });
    const res = await resetMemory(client(f), 'memory');
    expect(f.calls[0].url).toBe('http://h/api/memory/reset');
    expect(f.calls[0].init.method).toBe('POST');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ target: 'memory' });
    expect(res.deleted).toEqual(['MEMORY.md']);
  });

  it('resetMemory supports all three targets', async () => {
    for (const target of ['all', 'memory', 'user'] as const) {
      const f = fakeFetch(200, { ok: true, deleted: [] });
      await resetMemory(client(f), target);
      expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ target });
    }
  });

  describe('providerLabel', () => {
    it('maps "" to 内置文件', () => {
      expect(providerLabel('')).toBe('内置文件');
    });
    it('passes provider names through', () => {
      expect(providerLabel('mem0')).toBe('mem0');
    });
  });

  describe('memory file routes (hermes-mobile plugin)', () => {
    it('listMemoryFiles hits GET /api/plugins/mobile/memory/files', async () => {
      const files = [
        { name: 'MEMORY.md', size: 1234, mtime: 1760000000, exists: true },
        { name: 'USER.md', size: 0, mtime: 0, exists: false },
      ];
      const f = fakeFetch(200, { files });
      const res = await listMemoryFiles(client(f));
      expect(f.calls[0].url).toBe('http://h/api/plugins/mobile/memory/files');
      expect(f.calls[0].init.method).toBeUndefined(); // GET
      expect(res.files).toEqual(files);
    });

    it('readMemoryFile GETs the named file', async () => {
      const f = fakeFetch(200, { name: 'USER.md', content: '# About the user\n' });
      const res = await readMemoryFile(client(f), 'USER.md');
      expect(f.calls[0].url).toBe('http://h/api/plugins/mobile/memory/files/USER.md');
      expect(res.content).toBe('# About the user\n');
    });

    it('writeMemoryFile PUTs {content} to the named file', async () => {
      const f = fakeFetch(200, { ok: true, name: 'MEMORY.md', size: 5 });
      const res = await writeMemoryFile(client(f), 'MEMORY.md', 'hello');
      expect(f.calls[0].url).toBe('http://h/api/plugins/mobile/memory/files/MEMORY.md');
      expect(f.calls[0].init.method).toBe('PUT');
      expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ content: 'hello' });
      expect(res).toEqual({ ok: true, name: 'MEMORY.md', size: 5 });
    });

    it('writeMemoryFile surfaces 413 over the size cap', async () => {
      const f = fakeFetch(413, { detail: 'content exceeds 262144 bytes' });
      await expect(writeMemoryFile(client(f), 'MEMORY.md', 'x')).rejects.toThrow('content exceeds 262144 bytes');
    });
  });

  describe('isMemoryFileName', () => {
    it('accepts exactly the two allowlisted names', () => {
      expect(isMemoryFileName('MEMORY.md')).toBe(true);
      expect(isMemoryFileName('USER.md')).toBe(true);
    });
    it('rejects everything else, including traversal and case tricks', () => {
      for (const bad of ['memory.md', 'MEMORY.MD', '../MEMORY.md', 'MEMORY.md/..', 'SECRET.md', '', null, undefined, 7]) {
        expect(isMemoryFileName(bad)).toBe(false);
      }
    });
  });

  describe('memoryFileLabel', () => {
    it('matches the admin screen wording', () => {
      expect(memoryFileLabel('MEMORY.md')).toBe('智能体记忆');
      expect(memoryFileLabel('USER.md')).toBe('用户档案');
    });
  });

  describe('utf8ByteLength', () => {
    it('counts ASCII as 1 byte per char', () => {
      expect(utf8ByteLength('')).toBe(0);
      expect(utf8ByteLength('hello')).toBe(5);
    });
    it('counts 2/3/4-byte sequences like the server UTF-8 encode', () => {
      expect(utf8ByteLength('é')).toBe(2); // U+00E9
      expect(utf8ByteLength('€')).toBe(3); // U+20AC
      expect(utf8ByteLength('𝄞')).toBe(4); // U+1D11E (surrogate pair)
      expect(utf8ByteLength('🎺')).toBe(4); // U+1F3BA
      expect(utf8ByteLength('aé€🎺')).toBe(1 + 2 + 3 + 4);
    });
    it('counts a lone surrogate as 3 bytes (TextEncoder replacement-char behavior)', () => {
      expect(utf8ByteLength('\uD800')).toBe(3);
    });
  });

  describe('memoryFileTooLarge (262144/262145 boundary)', () => {
    it('allows exactly MEMORY_FILE_MAX_BYTES', () => {
      expect(MEMORY_FILE_MAX_BYTES).toBe(262144);
      expect(memoryFileTooLarge('a'.repeat(262144))).toBe(false);
    });
    it('rejects one byte over', () => {
      expect(memoryFileTooLarge('a'.repeat(262145))).toBe(true);
    });
    it('counts bytes, not chars, for multibyte content', () => {
      const twoByte = 'é'.repeat(262144 / 2); // exactly at the cap
      expect(memoryFileTooLarge(twoByte)).toBe(false);
      expect(memoryFileTooLarge(twoByte + 'a')).toBe(true);
    });
  });

  describe('isMemoryPluginMissing', () => {
    it('is true for 404/405 (routes not mounted — plugin absent or too old)', () => {
      expect(isMemoryPluginMissing(new HttpError(404, 'HTTP 404'))).toBe(true);
      expect(isMemoryPluginMissing(new HttpError(405, 'HTTP 405'))).toBe(true);
    });
    it('is false for other failures', () => {
      expect(isMemoryPluginMissing(new HttpError(503, 'HTTP 503'))).toBe(false);
      expect(isMemoryPluginMissing(new HttpError(413, 'HTTP 413'))).toBe(false);
      expect(isMemoryPluginMissing(new AuthError('expired'))).toBe(false);
      expect(isMemoryPluginMissing(new Error('network down'))).toBe(false);
      expect(isMemoryPluginMissing(undefined)).toBe(false);
    });
  });

  describe('memoryWriteErrorMessage', () => {
    it('maps the size cap (413) to a friendly limit message', () => {
      expect(memoryWriteErrorMessage(new HttpError(413, 'HTTP 413'))).toBe(
        '文件过大，记忆文件最多为 256 KB。',
      );
    });
    it('maps 403 to a permission message', () => {
      expect(memoryWriteErrorMessage(new HttpError(403, 'HTTP 403'))).toMatch(/权限不足/);
    });
    it('maps 404/405 to a plugin-update hint', () => {
      expect(memoryWriteErrorMessage(new HttpError(404, 'HTTP 404'))).toMatch(/更新.*hermes-mobile 插件/);
      expect(memoryWriteErrorMessage(new HttpError(405, 'HTTP 405'))).toMatch(/更新.*hermes-mobile 插件/);
    });
    it('maps 503 to a retry hint', () => {
      expect(memoryWriteErrorMessage(new HttpError(503, 'HTTP 503'))).toMatch(/不可用/);
    });
    it('passes through other error messages and falls back for non-errors', () => {
      expect(memoryWriteErrorMessage(new Error('Network request failed'))).toBe('Network request failed');
      expect(memoryWriteErrorMessage('weird')).toBe('保存失败，网关未接受修改。');
    });
  });

  describe('formatBytes', () => {
    it('treats 0 (absent file) as Empty', () => {
      expect(formatBytes(0)).toBe('暂无内容');
    });
    it('handles negatives and non-finite defensively', () => {
      expect(formatBytes(-5)).toBe('暂无内容');
      expect(formatBytes(NaN)).toBe('暂无内容');
    });
    it('formats bytes', () => {
      expect(formatBytes(1)).toBe('1 B');
      expect(formatBytes(1023)).toBe('1023 B');
    });
    it('formats kilobytes, trimming trailing .0', () => {
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(567)).toBe('567 B');
    });
    it('formats megabytes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
      expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    });
  });
});
