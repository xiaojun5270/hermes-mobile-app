import { Profiler } from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Composer } from '../src/components/composer';
import type { ComposerMode } from '../src/lib/turn-controller';

jest.mock('../src/components/icon', () => ({ Icon: () => null }));

function setup(mode: ComposerMode, extra: { value?: string; stagedImageUri?: string | null; disabled?: boolean } = {}) {
  const handlers = { onSend: jest.fn(), onStop: jest.fn(), onSteer: jest.fn(), onChangeText: jest.fn() };
  return { handlers, el: <Composer value={extra.value ?? ''} mode={mode} stagedImageUri={extra.stagedImageUri ?? null} disabled={extra.disabled} {...handlers} /> };
}

test('idle with only a staged photo: Send is enabled (review m9)', async () => {
  const { el, handlers } = setup({ kind: 'send', enabled: true }, { stagedImageUri: 'file:///p.jpg' });
  await render(el);
  await fireEvent.press(screen.getByRole('button', { name: '发送消息' }));
  expect(handlers.onSend).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '停止回复' })).toBeNull();
});

test('idle, empty: Send disabled, placeholder "与 Hermes 对话"', async () => {
  const { el } = setup({ kind: 'send', enabled: false });
  await render(el);
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  expect(screen.getByPlaceholderText('与 Hermes 对话')).toBeOnTheScreen();
});

test('streaming, empty input: Stop only, placeholder "引导当前任务…", input editable', async () => {
  const { el, handlers } = setup({ kind: 'stop+steer', stopEnabled: true, steerEnabled: false });
  await render(el);
  expect(screen.getByPlaceholderText('引导当前任务…').props.editable).toBe(true);
  expect(screen.queryByRole('button', { name: '发送引导消息' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '停止回复' }));
  expect(handlers.onStop).toHaveBeenCalledTimes(1);
});

test('streaming with text: Stop + steer-send; steer never calls onSend', async () => {
  const { el, handlers } = setup({ kind: 'stop+steer', stopEnabled: true, steerEnabled: true }, { value: 'use tabs' });
  await render(el);
  await fireEvent.press(screen.getByRole('button', { name: '发送引导消息' }));
  expect(handlers.onSteer).toHaveBeenCalledTimes(1);
  expect(handlers.onSend).not.toHaveBeenCalled();
});

test('stopping: "正在停止…", Stop and steer disabled', async () => {
  const { el, handlers } = setup({ kind: 'stop+steer', stopEnabled: false, steerEnabled: false }, { value: 'x' });
  await render(el);
  expect(screen.getByText('正在停止…')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: '正在停止回复' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '发送引导消息' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: '正在停止回复' }));
  expect(handlers.onStop).not.toHaveBeenCalled();
});

// Final review m5: nothing sends the photo on its own when the turn ends, so the copy must not promise it.
test('a staged photo while streaming says it can be sent once the turn finishes', async () => {
  const { el } = setup({ kind: 'stop+steer', stopEnabled: true, steerEnabled: false }, { stagedImageUri: 'file:///p.jpg' });
  await render(el);
  expect(screen.getByText('本轮结束后可发送这张照片')).toBeOnTheScreen();
  expect(screen.queryByText(/^Sends after/)).toBeNull();
});

test('not ready: Stop disabled too', async () => {
  const { el } = setup({ kind: 'stop+steer', stopEnabled: true, steerEnabled: false }, { disabled: true });
  await render(el);
  expect(screen.getByRole('button', { name: '停止回复' })).toBeDisabled();
});

// ── Re-measure trigger for JS-driven value sets (src/lib/composer-height.ts, Preflight F1) ──────

const running: ComposerMode = { kind: 'stop+steer', stopEnabled: true, steerEnabled: true };
const multiLine = 'Actually, use tabs.\nAnd keep the imports sorted.\nThen rerun the tests.';

/** Records the TextInput's minHeight as committed by each render pass (Profiler onRender runs in
 *  the commit, after the host tree is updated), so a test can tell the value commit from the
 *  follow-up one. */
function measured(onChangeText: (t: string) => void = () => {}) {
  const perCommit: unknown[] = [];
  let rendered = false; // `screen` exists only once the first render() returns
  const minHeight = () => StyleSheet.flatten(screen.getByPlaceholderText('引导当前任务…').props.style).minHeight;
  const el = (value: string) => (
    <Profiler id="composer" onRender={() => void (rendered && perCommit.push(minHeight()))}>
      <Composer value={value} mode={running} onChangeText={onChangeText} onSend={() => {}} onStop={() => {}} onSteer={() => {}} />
    </Profiler>
  );
  /** minHeights committed since the last call (the first call also arms recording). */
  const commits = () => {
    rendered = true;
    return perCommit.splice(0);
  };
  return { el, commits };
}

test('a JS-driven non-empty set (failed steer restore) gets a follow-up commit that flips minHeight', async () => {
  const m = measured();
  const view = await render(m.el('')); // steer just cleared the input
  m.commits();
  await view.rerender(m.el(multiLine)); // setInput((cur) => restoreSteerText(cur, text))
  // The value commit is measured against the old (empty) text; the follow-up must change a host
  // prop so Fabric re-measures the restored text.
  const all = m.commits();
  expect(all).toHaveLength(2); // the value commit + exactly one follow-up
  const [valueCommit, followUp] = all;
  expect(followUp).not.toBe(valueCommit);
});

test('restoring exactly the text the user had typed still counts as a JS set', async () => {
  let latest = '';
  const m = measured((t) => void (latest = t));
  const view = await render(m.el(''));
  await fireEvent.changeText(screen.getByPlaceholderText('引导当前任务…'), 'use tabs');
  await view.rerender(m.el(latest)); // parent echoes the typed text
  await view.rerender(m.el('')); // steer clears
  m.commits();
  await view.rerender(m.el('use tabs')); // steer failed: restore the identical text
  const all = m.commits();
  expect(all).toHaveLength(2); // the value commit + exactly one follow-up
  const [valueCommit, followUp] = all;
  expect(followUp).not.toBe(valueCommit);
});

test('a JS-driven clear still gets its follow-up commit (C behaviour kept)', async () => {
  let latest = '';
  const m = measured((t) => void (latest = t));
  const view = await render(m.el(''));
  await fireEvent.changeText(screen.getByPlaceholderText('引导当前任务…'), multiLine);
  await view.rerender(m.el(latest));
  m.commits();
  await view.rerender(m.el('')); // send / steer clears
  const all = m.commits();
  expect(all).toHaveLength(2); // the value commit + exactly one follow-up
  const [valueCommit, followUp] = all;
  expect(followUp).not.toBe(valueCommit);
});

test('typed text echoed back by the parent never triggers a follow-up commit', async () => {
  let latest = '';
  const m = measured((t) => void (latest = t));
  const view = await render(m.el(''));
  await fireEvent.changeText(screen.getByPlaceholderText('引导当前任务…'), multiLine);
  m.commits();
  await view.rerender(m.el(latest));
  expect(m.commits()).toHaveLength(1);
});
