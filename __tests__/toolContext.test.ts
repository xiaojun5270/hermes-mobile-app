import { toolContextFromArgs } from '../src/lib/tool-context';

describe('toolContextFromArgs — primary-arg map', () => {
  it('maps terminal → command', () => {
    expect(toolContextFromArgs('terminal', { command: 'ls -la' })).toBe('ls -la');
  });
  it('maps write_file/read_file/patch → path', () => {
    expect(toolContextFromArgs('write_file', { path: '/a/b.txt' })).toBe('/a/b.txt');
    expect(toolContextFromArgs('read_file', { path: '/a/b.txt' })).toBe('/a/b.txt');
    expect(toolContextFromArgs('patch', { path: '/a/b.txt' })).toBe('/a/b.txt');
  });
  it('maps browser_navigate → url and web_search → query', () => {
    expect(toolContextFromArgs('browser_navigate', { url: 'https://x.dev' })).toBe('https://x.dev');
    expect(toolContextFromArgs('web_search', { query: 'hermes' })).toBe('hermes');
  });
  it('takes the first element of a list-valued arg (web_extract → urls)', () => {
    expect(toolContextFromArgs('web_extract', { urls: ['https://a', 'https://b'] })).toBe('https://a');
  });
  it('collapses whitespace and truncates to 80 chars with an ellipsis', () => {
    expect(toolContextFromArgs('terminal', { command: 'echo   a\n\n  b' })).toBe('echo a b');
    const long = 'x'.repeat(100);
    const out = toolContextFromArgs('terminal', { command: long })!;
    expect(out).toHaveLength(80);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('toolContextFromArgs — fallback + empties', () => {
  it('falls back through the key order for unmapped tools', () => {
    expect(toolContextFromArgs('mystery_tool', { name: 'thing' })).toBe('thing');
  });
  it('returns undefined for no/empty args', () => {
    expect(toolContextFromArgs('terminal', {})).toBeUndefined();
    expect(toolContextFromArgs('terminal', undefined)).toBeUndefined();
    expect(toolContextFromArgs('terminal', 'not-an-object')).toBeUndefined();
  });
  it('returns undefined when the chosen value is empty', () => {
    expect(toolContextFromArgs('terminal', { command: '   ' })).toBeUndefined();
  });
});

describe('toolContextFromArgs — special cases', () => {
  it('todo: reading / planning / updating', () => {
    expect(toolContextFromArgs('todo', { merge: false })).toBe('读取任务列表'); // todos undefined
    expect(toolContextFromArgs('todo', { todos: [1, 2, 3] })).toBe('规划 3 个任务');
    expect(toolContextFromArgs('todo', { todos: [1, 2], merge: true })).toBe('更新 2 个任务');
  });
  it('delegate_task: single goal and batch', () => {
    expect(toolContextFromArgs('delegate_task', { goal: 'do the thing' })).toBe('do the thing');
    expect(
      toolContextFromArgs('delegate_task', { tasks: [{ goal: 'a' }, { goal: 'b' }] }),
    ).toBe('2 个任务：a | b');
    expect(toolContextFromArgs('delegate_task', { tasks: [{}, {}] })).toBe('2 个任务：? | ?');
    expect(toolContextFromArgs('delegate_task', { tasks: [] })).toBe('0 个并行任务');
  });
  it('memory: add / replace / remove', () => {
    expect(toolContextFromArgs('memory', { action: 'add', target: 'notes', content: 'remember me' }))
      .toBe('+notes: "remember me"');
    expect(toolContextFromArgs('memory', { action: 'replace', target: 'notes', old_text: 'old' }))
      .toBe('~notes: "old"');
    expect(toolContextFromArgs('memory', { action: 'remove', target: 'notes' }))
      .toBe('-notes: "<缺少 old_text>"');
    expect(toolContextFromArgs('memory', { action: 'replace', target: 'notes' }))
      .toBe('~notes: "<缺少 old_text>"');
  });
  it('send_message: target defaults to ? and message truncates at 20', () => {
    expect(toolContextFromArgs('send_message', { message: 'hi' })).toBe('发送至 ?: "hi"');
    expect(toolContextFromArgs('send_message', { target: 'bob', message: 'x'.repeat(30) }))
      .toBe(`发送至 bob: "${'x'.repeat(17)}..."`);
  });
  it('session_search: recall with 25-char cap', () => {
    expect(toolContextFromArgs('session_search', { query: 'find it' })).toBe('回忆: "find it"');
  });
  it('process: joins action, session id (16), data (20), and wait timeout', () => {
    expect(toolContextFromArgs('process', { action: 'wait', session_id: 'sess1234567890abcdef', timeout: 5 }))
      .toBe('wait sess1234567890ab 5s');
  });
});

describe('toolContextFromArgs — truncation caps match the gateway wire', () => {
  // The live tool.start context is build_tool_preview(name, args, max_len=80)
  // (tui_gateway/server.py `_tool_ctx`). These pin the caps so a rehydrated
  // card's context can never silently diverge from the live one.
  it('caps the general primary-arg preview at 80 with a 3-dot ellipsis', () => {
    const out = toolContextFromArgs('read_file', { path: '/' + 'p'.repeat(200) })!;
    expect(out).toHaveLength(80);
    expect(out.endsWith('...')).toBe(true);
  });
  it('session_search caps the recalled query at 25 chars', () => {
    expect(toolContextFromArgs('session_search', { query: 'q'.repeat(40) })).toBe(
      `回忆: "${'q'.repeat(25)}..."`,
    );
  });
  it('memory add caps the content at 25 chars', () => {
    expect(toolContextFromArgs('memory', { action: 'add', target: 'n', content: 'c'.repeat(40) })).toBe(
      `+n: "${'c'.repeat(25)}..."`,
    );
  });
  it('delegate_task batch caps each goal at 40 chars', () => {
    expect(toolContextFromArgs('delegate_task', { tasks: [{ goal: 'g'.repeat(60) }] })).toBe(
      `1 个任务：${'g'.repeat(37)}...`,
    );
  });
});
