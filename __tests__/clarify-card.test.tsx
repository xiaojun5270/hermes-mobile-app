import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { TextInput } from 'react-native';
import { ClarifyCard } from '../src/components/clarify-card';
import type { RequestCardState } from '../src/lib/turn-controller';
import { palettes } from '../src/theme';

const colors = palettes.light; // jest's color scheme

jest.mock('../src/components/icon', () => ({ Icon: () => null }));

const card = (params: Record<string, unknown>, over: Partial<RequestCardState> = {}): RequestCardState => ({
  id: 'srq-c', kind: 'clarify', method: 'clarify', status: 'pending', legacy: false, receivedAt: 0, anchorKey: null,
  params: { session_id: 's', ...params }, ...over,
});
const responder = () => ({
  clarifySingle: jest.fn((_c: RequestCardState, _a: string | string[]) => ({ ok: true as const })),
  clarifyLock: jest.fn(async (_c: RequestCardState, _q: string, _a: string | string[]) => 'ok' as const),
  clarifySubmitAll: jest.fn(async (_c: RequestCardState, _a: { qid: string; answer: string | string[] }[]) => 'resolved' as const),
  clarifySkipAll: jest.fn((_c: RequestCardState) => ({ ok: true as const })),
});
const batch = {
  questions: [
    { qid: 'q0', question: 'Which env?', choices: ['staging (Recommended)', 'prod'], multi_select: false },
    { qid: 'q1', question: 'Anything else?', choices: null, multi_select: false },
  ],
};

test('single: 推荐 badge, radio choice, Send sends the label', async () => {
  const r = responder();
  const c = card({ question: 'Color?', choices: ['Blue (Recommended)', 'Red'] });
  await render(<ClarifyCard card={c} responder={r} />);
  expect(screen.getByText('推荐')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: '发送回答' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('radio', { name: 'Blue，推荐' }));
  await fireEvent.press(screen.getByRole('button', { name: '发送回答' }));
  expect(r.clarifySingle).toHaveBeenCalledWith(c, 'Blue');
  expect(r.clarifyLock).not.toHaveBeenCalled();
});

test('single: Other text replaces the radio choice', async () => {
  const r = responder();
  await render(<ClarifyCard card={card({ question: 'Color?', choices: ['Red'] })} responder={r} />);
  await fireEvent.press(screen.getByRole('radio', { name: 'Red' }));
  await fireEvent.changeText(screen.getByLabelText('其他回答'), 'Teal');
  await fireEvent.press(screen.getByRole('button', { name: '发送回答' }));
  expect(r.clarifySingle.mock.calls[0][1]).toBe('Teal');
});

test('single: choices null → text field only; Skip sends ""', async () => {
  const r = responder();
  await render(<ClarifyCard card={card({ question: 'Why?', choices: null })} responder={r} />);
  expect(screen.queryAllByRole('radio')).toHaveLength(0);
  expect(screen.getByLabelText('回答')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '跳过问题' }));
  expect(r.clarifySingle.mock.calls[0][1]).toBe('');
});

test('single multi-select: checkboxes, sends an array', async () => {
  const r = responder();
  await render(<ClarifyCard card={card({ question: 'Pick', choices: ['A', 'B', 'C'], multi_select: true })} responder={r} />);
  await fireEvent.press(screen.getByRole('checkbox', { name: 'C' }));
  await fireEvent.press(screen.getByRole('checkbox', { name: 'A' }));
  expect(screen.getByRole('checkbox', { name: 'A' })).toBeChecked();
  await fireEvent.press(screen.getByRole('button', { name: '发送回答' }));
  expect(r.clarifySingle.mock.calls[0][1]).toEqual(['A', 'C']);
});

test('batch: Confirm on a multi-select question locks a real array, not a joined string', async () => {
  const r = responder();
  const c = card({
    questions: [{ qid: 'q0', question: 'Pick', choices: ['A', 'B', 'C'], multi_select: true }],
  });
  await render(<ClarifyCard card={c} responder={r} />);
  await fireEvent.press(screen.getByRole('checkbox', { name: 'A' }));
  await fireEvent.press(screen.getByRole('checkbox', { name: 'C' }));
  await fireEvent.press(screen.getByRole('button', { name: '确认问题的回答 1' }));
  expect(r.clarifyLock).toHaveBeenCalledWith(c, 'q0', ['A', 'C']);
  const sentAnswer = r.clarifyLock.mock.calls[0][2];
  expect(Array.isArray(sentAnswer)).toBe(true);
  expect(typeof sentAnswer).not.toBe('string');
});

test('batch: Confirm locks one question, per-question Skip locks ""', async () => {
  const r = responder();
  const c = card(batch);
  await render(<ClarifyCard card={c} responder={r} />);
  expect(screen.getByText('Hermes 有 2个问题')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('radio', { name: 'prod' }));
  await fireEvent.press(screen.getByRole('button', { name: '确认问题的回答 1' }));
  await fireEvent.press(screen.getByRole('button', { name: '跳过问题 2' }));
  expect(r.clarifyLock.mock.calls).toEqual([[c, 'q0', 'prod'], [c, 'q1', '']]);
});

test('batch: 全部提交 only sends unlocked个问题 (Review Focus 4)', async () => {
  const r = responder();
  const c = card({ ...batch, answers: { q0: 'staging' } }, { lockedAnswers: { q0: 'staging' } });
  await render(<ClarifyCard card={c} responder={r} />);
  expect(screen.getByText('staging')).toBeOnTheScreen(); // replayed lock renders as answered
  expect(screen.queryByRole('radio', { name: 'prod' })).toBeNull();
  await fireEvent.changeText(screen.getByLabelText('回答，问题 2'), 'no');
  await fireEvent.press(screen.getByRole('button', { name: '提交所有回答' }));
  expect(r.clarifySubmitAll).toHaveBeenCalledWith(c, [{ qid: 'q1', answer: 'no' }]);
});

test('batch: replayed multi-select lock renders as a list; 全部跳过 cancels', async () => {
  const r = responder();
  const c = card(batch, { lockedAnswers: { q0: '["a","b"]' } });
  await render(<ClarifyCard card={c} responder={r} />);
  expect(screen.getByText('a, b')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '跳过所有问题' }));
  expect(r.clarifySkipAll).toHaveBeenCalledWith(c);
});

test('batch: an empty locked answer has a Chinese skipped label, with the question unchanged', async () => {
  await render(<ClarifyCard card={card(batch, { lockedAnswers: { q0: '' } })} responder={responder()} />);
  expect(screen.getByLabelText('问题 1已回答：已跳过')).toBeOnTheScreen();
  expect(screen.getByText('1. Which env?')).toBeOnTheScreen();
  expect(screen.queryByRole('radio', { name: 'prod' })).toBeNull();
});

test('a failed lock shows a retry note', async () => {
  const r = responder();
  r.clarifyLock.mockResolvedValueOnce('failed' as never);
  await render(<ClarifyCard card={card(batch)} responder={r} />);
  await fireEvent.press(screen.getByRole('button', { name: '跳过问题 2' }));
  expect(await screen.findByText('无法发送回答，请重试。')).toBeOnTheScreen();
});

test('single: a failed Send is retried and the note clears on success', async () => {
  const r = responder();
  r.clarifySingle
    .mockReturnValueOnce({ ok: false, message: '无法发送回答，请重试。' } as never)
    .mockReturnValueOnce({ ok: true });
  const c = card({ question: 'Color?', choices: ['Blue'] });
  await render(<ClarifyCard card={c} responder={r} />);
  await fireEvent.press(screen.getByRole('radio', { name: 'Blue' }));
  await fireEvent.press(screen.getByRole('button', { name: '发送回答' }));
  expect(await screen.findByText('无法发送回答，请重试。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '发送回答' }));
  expect(screen.queryByText('无法发送回答，请重试。')).toBeNull();
});

test('batch: a failed 全部跳过 shows a note and the card stays pending', async () => {
  const r = responder();
  r.clarifySkipAll.mockReturnValueOnce({ ok: false, message: 'Couldn\'t skip. 重试.' } as never);
  const c = card(batch);
  await render(<ClarifyCard card={c} responder={r} />);
  await fireEvent.press(screen.getByRole('button', { name: '跳过所有问题' }));
  expect(await screen.findByText('Couldn\'t skip. 重试.')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: '提交所有回答' })).not.toBeDisabled();
});

test.each([
  [{ status: 'cancelled', cancelReason: 'timeout' }, '已超时'],
  [{ status: 'cancelled', cancelReason: 'interrupted' }, '已停止'],
  [{ status: 'skipped' }, '已跳过'],
  [{ status: 'answered', resolution: 'Blue' }, '已回答：Blue'],
] as [Partial<RequestCardState>, string][])('settled %o → %s, no controls', async (over, label) => {
  await render(<ClarifyCard card={card({ question: 'Color?', choices: ['Blue'] }, over)} responder={responder()} />);
  expect(screen.getByText(label)).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: '发送回答' })).toBeNull();
});

test('focusing a free-text field hands the screen that field to scroll into view (Review Focus 5)', async () => {
  const onInputFocus = jest.fn();
  await render(<ClarifyCard card={card({ question: 'Why?', choices: null })} responder={responder()} onInputFocus={onInputFocus} />);
  await fireEvent(screen.getByLabelText('回答'), 'focus');
  expect(onInputFocus).toHaveBeenCalledTimes(1);
  expect(onInputFocus.mock.calls[0][0]).toEqual(expect.any(Function)); // a measure callback, not the field
});

// Sim S2 §1 (B2): in a tall batch the screen must reveal the FOCUSED field, not the card, so each
// question's field reports itself.
test('batch: focusing question 2 hands over question 2\'s field, not the first one', async () => {
  const onInputFocus = jest.fn();
  await render(<ClarifyCard card={card(batch)} responder={responder()} onInputFocus={onInputFocus} />);
  await fireEvent(screen.getByLabelText('回答，问题 2'), 'focus');
  const spy = jest.spyOn(TextInput.prototype, 'measureInWindow');
  const cb = jest.fn();
  onInputFocus.mock.calls[0][0](cb);
  expect(spy).toHaveBeenCalledWith(cb);
  expect((spy.mock.contexts[0] as TextInput).props.accessibilityLabel).toBe('回答，问题 2');
  spy.mockRestore();
});

// Sim S1 §2 visual defects.
test('V1: the title shrinks instead of overflowing the card at accessibility sizes', async () => {
  await render(<ClarifyCard card={card({ question: 'Why?', choices: null })} responder={responder()} />);
  expect(screen.getByText('Hermes 有一个问题')).toHaveStyle({ flexShrink: 1 });
});

test('V3: a settled batch shows only the summary — no fields, choices or buttons', async () => {
  const c = card(batch, { status: 'cancelled', cancelReason: 'timeout', lockedAnswers: { q0: 'staging' } });
  await render(<ClarifyCard card={c} responder={responder()} />);
  expect(screen.getByText('已超时')).toBeOnTheScreen();
  expect(screen.getByText('staging')).toBeOnTheScreen(); // the locked answer stays
  expect(screen.getByText('2. Anything else?')).toBeOnTheScreen(); // the unanswered question, as text
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.queryAllByRole('radio')).toHaveLength(0);
  expect(screen.queryByLabelText('回答，问题 2')).toBeNull();
});

test('V3: a settled single question draws no field', async () => {
  const c = card({ question: 'Why?', choices: ['Speed'] }, { status: 'cancelled', cancelReason: 'timeout' });
  await render(<ClarifyCard card={c} responder={responder()} />);
  expect(screen.getByText('Why?')).toBeOnTheScreen();
  expect(screen.queryByLabelText('其他回答')).toBeNull();
  expect(screen.queryAllByRole('radio')).toHaveLength(0);
});

test('V4: one primary per batch card — per-question Confirm is secondary, 全部提交 is the accent', async () => {
  await render(<ClarifyCard card={card(batch)} responder={responder()} />);
  for (const confirm of screen.getAllByRole('button', { name: /^确认问题的回答/ })) {
    expect(confirm).not.toHaveStyle({ backgroundColor: colors.accent });
  }
  expect(screen.getByRole('button', { name: '提交所有回答' })).toHaveStyle({ backgroundColor: colors.accent });
});

test('V5: a locked batch question keeps its number', async () => {
  await render(<ClarifyCard card={card(batch, { lockedAnswers: { q0: 'staging' } })} responder={responder()} />);
  expect(screen.getByText('1. Which env?')).toBeOnTheScreen();
  expect(screen.getByText('2. Anything else?')).toBeOnTheScreen();
});

// Final review m3: a malformed clarify threw in render and RouteError replaced the whole chat. It now
// reads "can't be shown" and offers Skip (a cancel-all response, the contract's decline) — never -32601.
describe('malformed params (m3)', () => {
  const broken = (over: Partial<RequestCardState> = {}): RequestCardState => ({ ...card({}), params: null, ...over });

  test('renders a safe card with Skip, which sends the cancel-all response', async () => {
    const r = responder();
    const c = broken();
    await render(<ClarifyCard card={c} responder={r} />);
    expect(screen.getByText('此请求无法显示。')).toBeOnTheScreen();
    expect(screen.queryByLabelText('回答')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: '跳过此请求' }));
    expect(r.clarifySkipAll).toHaveBeenCalledWith(c);
    expect(r.clarifySingle).not.toHaveBeenCalled();
    expect(r.clarifyLock).not.toHaveBeenCalled();
  });

  test('a batch with a malformed question is not half-drawn', async () => {
    await render(<ClarifyCard card={card({ questions: [{ qid: 'q0', question: 'Env?' }, { qid: 'q1' }] })} responder={responder()} />);
    expect(screen.getByText('此请求无法显示。')).toBeOnTheScreen();
    expect(screen.queryByText(/Env\?/)).toBeNull();
  });

  test('once settled it shows the outcome, no Skip', async () => {
    await render(<ClarifyCard card={broken({ status: 'skipped' })} responder={responder()} />);
    expect(screen.getByText('已跳过')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: '跳过此请求' })).toBeNull();
  });
});

// Final review m6: a lock that failed after the card was closed (Stopped / Timed out) showed
// "Try again" under a card that can no longer be answered.
describe('a failed lock on a card that settled meanwhile (m6)', () => {
  test.each([
    ['lock', '跳过问题 2', '无法发送回答，请重试。'],
    ['全部提交', '提交所有回答', '部分回答未能发送，请重试。'],
  ])('%s: no retry note once the card is closed', async (_name, button, retry) => {
    const r = responder();
    let fail!: () => void;
    const gate = new Promise<'failed'>((res) => (fail = () => res('failed')));
    r.clarifyLock.mockReturnValueOnce(gate as never);
    r.clarifySubmitAll.mockReturnValueOnce(gate as never);
    const open = card(batch);
    const { rerender } = await render(<ClarifyCard card={open} responder={r} />);
    await fireEvent.press(screen.getByRole('button', { name: button }));
    await rerender(<ClarifyCard card={{ ...open, status: 'cancelled', cancelReason: 'interrupted' }} responder={r} />);
    await act(async () => fail());
    expect(screen.getByText('已停止')).toBeOnTheScreen();
    expect(screen.queryByText(retry)).toBeNull();
  });
});
