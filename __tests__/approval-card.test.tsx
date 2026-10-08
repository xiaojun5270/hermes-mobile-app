import { fireEvent, render, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { ApprovalCard } from '../src/components/approval-card';
import type { RequestCardState } from '../src/lib/turn-controller';
import { palettes } from '../src/theme';

const colors = palettes.light; // jest's color scheme

jest.mock('../src/components/icon', () => ({ Icon: () => null }));
const mockSheet = jest.fn();
jest.mock('../src/lib/action-sheet', () => ({ showActionSheet: (...a: unknown[]) => mockSheet(...a) }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(async () => {}), ImpactFeedbackStyle: { Medium: 'medium' } }));

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
beforeEach(() => {
  mockSheet.mockReset();
  alertSpy.mockClear();
});
const all4 = { session_id: 's', request_id: 'r', command: 'rm -rf build', description: 'Recursive delete', pattern_key: 'recursive delete', choices: ['once', 'session', 'always', 'deny'] };
const MORE = { name: '更多授权选项' };

const card = (over: Partial<RequestCardState> = {}): RequestCardState => ({
  id: 'srq-1', kind: 'approval', method: 'approval', status: 'pending', legacy: false, receivedAt: 0, anchorKey: null,
  params: { session_id: 's', request_id: 'r', command: 'rm -rf build', description: 'Recursive delete' },
  ...over,
});

test('pending + actionable: Approve sends once, Deny sends deny', async () => {
  const onRespond = jest.fn();
  await render(<ApprovalCard card={card()} actionable onRespond={onRespond} />);
  expect(screen.getByText('rm -rf build')).toBeOnTheScreen();
  expect(screen.getByText('Recursive delete')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '批准，仅运行一次' }));
  await fireEvent.press(screen.getByRole('button', { name: '拒绝并阻止此命令' }));
  expect(onRespond.mock.calls).toEqual([['once'], ['deny']]);
});

test('legacy, not the oldest: disabled with the FIFO hint', async () => {
  const onRespond = jest.fn();
  await render(<ApprovalCard card={card({ id: 'legacy:2', legacy: true })} actionable={false} onRespond={onRespond} />);
  expect(screen.getByText('等待上方较早的授权请求…')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '批准，仅运行一次' }));
  expect(onRespond).not.toHaveBeenCalled();
});

test('answering shows 正在发送…', async () => {
  await render(<ApprovalCard card={card({ status: 'answering' })} actionable onRespond={jest.fn()} />);
  expect(screen.getByText('正在发送…')).toBeOnTheScreen();
});

test.each([
  [{ status: 'answered', resolution: 'once' }, '已批准'],
  [{ status: 'answered', resolution: 'deny' }, '已拒绝'],
  [{ status: 'answered', resolution: 'session' }, '已允许此会话'],
  [{ status: 'answered', resolution: 'always' }, '已永久允许'],
  [{ status: 'cancelled', cancelReason: 'interrupted' }, '已停止'],
  [{ status: 'cancelled', cancelReason: 'timeout' }, '已超时'],
  [{ status: 'cancelled', cancelReason: 'resolved' }, '已在其他设备回答'],
  [{ status: 'cancelled', cancelReason: 'shutdown' }, '已关闭'],
] as [Partial<RequestCardState>, string][])('settled %o → %s, no buttons', async (over, label) => {
  await render(<ApprovalCard card={card(over)} actionable={false} onRespond={jest.fn()} />);
  expect(screen.getByText(label)).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: '批准，仅运行一次' })).toBeNull();
});

// Sim S1 §2 V6: labels touched the button edges at accessibility sizes.
test('V6: Approve and Deny keep 44 pt with vertical padding', async () => {
  await render(<ApprovalCard card={card()} actionable onRespond={jest.fn()} />);
  for (const name of ['批准，仅运行一次', '拒绝并阻止此命令']) {
    expect(screen.getByRole('button', { name })).toHaveStyle({ minHeight: 44, paddingVertical: 8 });
  }
});

// Sim S1 §2 V7: a waiting (legacy FIFO) Approve was white on a faded accent in light.
test('V7: a disabled Approve uses the legible disabled treatment, not a faded accent', async () => {
  await render(<ApprovalCard card={card({ id: 'legacy:2', legacy: true })} actionable={false} onRespond={jest.fn()} />);
  const approve = screen.getByRole('button', { name: '批准，仅运行一次' });
  expect(approve).toHaveStyle({ backgroundColor: colors.surface });
  expect(approve.parent).not.toHaveStyle({ opacity: 0.45 }); // the row is no longer faded as a whole
  expect(screen.getByText('批准')).toHaveStyle({ color: colors.textDim });
});

// Sim S2 §3 (V11): a Tirith security-scan description ran ~10 lines and made the card very tall.
describe('V11: long description', () => {
  const long = 'Tirith could not finish its analysis of this command. '.repeat(8).trim();
  const layout = (lines: number) => ({ nativeEvent: { lines: Array.from({ length: lines }, () => ({})) } });
  const measurer = () => screen.getByTestId('approval-description-measure', { includeHiddenElements: true });

  test('clamps to 4 lines with a 展开 / 收起 toggle', async () => {
    await render(<ApprovalCard card={card({ params: { session_id: 's', command: 'python x.py', description: long } })} actionable onRespond={jest.fn()} />);
    await fireEvent(measurer(), 'textLayout', layout(10));
    expect(screen.getByText(long).props.numberOfLines).toBe(4);
    const more = screen.getByRole('button', { name: '展开描述' });
    expect(more).toBeCollapsed();
    await fireEvent.press(more);
    expect(screen.getByText(long).props.numberOfLines).toBeUndefined();
    expect(screen.getByRole('button', { name: '收起描述' })).toBeExpanded();
  });

  // Review fix round 1: fail open — until the twin reports overflow (and if it never does on a device)
  // the description is never clamped, so a security note can't be cut off with no way to read it.
  test('before any text layout the description is unclamped and there is no toggle', async () => {
    await render(<ApprovalCard card={card({ params: { session_id: 's', command: 'python x.py', description: long } })} actionable onRespond={jest.fn()} />);
    expect(screen.getByText(long).props.numberOfLines).toBeUndefined();
    expect(screen.queryByRole('button', { name: /of the description/ })).toBeNull();
  });

  test('a description that fits in 4 lines has no toggle', async () => {
    await render(<ApprovalCard card={card()} actionable onRespond={jest.fn()} />);
    await fireEvent(measurer(), 'textLayout', layout(4));
    expect(screen.queryByRole('button', { name: /of the description/ })).toBeNull();
    expect(screen.getByText('Recursive delete').props.numberOfLines).toBeUndefined();
  });
});

describe('更多选项 (session / always)', () => {
  test('offers both: the sheet lists them and session responds session', async () => {
    const onRespond = jest.fn();
    await render(<ApprovalCard card={card({ params: all4 })} actionable onRespond={onRespond} />);
    await fireEvent.press(screen.getByRole('button', MORE));
    expect(mockSheet).toHaveBeenCalledTimes(1);
    const [title, actions] = mockSheet.mock.calls[0];
    expect(title).toBe('recursive delete');
    expect(actions.map((a: { label: string }) => a.label)).toEqual(['允许此会话', '永久允许…']);
    actions[0].onPress();
    expect(onRespond.mock.calls).toEqual([['session']]);
  });

  test('always confirms before sending; Cancel sends nothing', async () => {
    const onRespond = jest.fn();
    await render(<ApprovalCard card={card({ params: all4 })} actionable onRespond={onRespond} />);
    await fireEvent.press(screen.getByRole('button', MORE));
    mockSheet.mock.calls[0][1][1].onPress();
    expect(onRespond).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alertSpy.mock.calls[0];
    expect(title).toBe('永久允许此命令？');
    expect(message).toContain('recursive delete');
    expect(message).toContain('config.yaml');
    expect(buttons).toEqual([
      { text: '取消', style: 'cancel' },
      { text: '永久允许', style: 'destructive', onPress: expect.any(Function) },
    ]);
    buttons![1].onPress!();
    expect(onRespond.mock.calls).toEqual([['always']]);
  });

  test('only session offered → one sheet action', async () => {
    await render(<ApprovalCard card={card({ params: { ...all4, choices: ['once', 'session', 'deny'] } })} actionable onRespond={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', MORE));
    expect(mockSheet.mock.calls[0][1].map((a: { label: string }) => a.label)).toEqual(['允许此会话']);
  });

  test('none offered → no 更多选项 link', async () => {
    await render(<ApprovalCard card={card({ params: { ...all4, choices: ['once', 'deny'] } })} actionable onRespond={jest.fn()} />);
    expect(screen.queryByRole('button', MORE)).toBeNull();
  });

  test('legacy not-oldest: disabled, cannot open the sheet', async () => {
    await render(<ApprovalCard card={card({ id: 'legacy:2', legacy: true, params: all4 })} actionable={false} onRespond={jest.fn()} />);
    const more = screen.getByRole('button', MORE);
    expect(more).toBeDisabled();
    await fireEvent.press(more);
    expect(mockSheet).not.toHaveBeenCalled();
  });

  test('keeps 44 pt', async () => {
    await render(<ApprovalCard card={card({ params: all4 })} actionable onRespond={jest.fn()} />);
    expect(screen.getByRole('button', MORE)).toHaveStyle({ minHeight: 44 });
  });

  test('settled row label names the choice', async () => {
    await render(<ApprovalCard card={card({ status: 'answered', resolution: 'session', params: all4 })} actionable={false} onRespond={jest.fn()} />);
    expect(screen.getByLabelText('操作授权 已允许此会话')).toBeOnTheScreen();
  });
});
