import { render, screen } from '@testing-library/react-native';
import { MessageRow } from '../src/components/message-row';
import { useTheme, type ThemeColors } from '../src/theme';

const mockIcon = jest.fn((_props: { sf: string; color?: string }) => null);
jest.mock('../src/components/icon', () => ({ Icon: (props: { sf: string; color?: string }) => mockIcon(props) }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(async () => {}), ImpactFeedbackStyle: { Light: 'light' } }));

test('a steered user message shows a "Steered" caption and says so to VoiceOver', async () => {
  await render(<MessageRow item={{ key: 'i1', role: 'user', text: 'use tabs', complete: true, steered: true }} />);
  expect(screen.getByText('已引导')).toBeOnTheScreen();
  expect(screen.getByLabelText('你的引导：use tabs')).toBeOnTheScreen();
});

test('a plain user message has no Steered caption', async () => {
  await render(<MessageRow item={{ key: 'i1', role: 'user', text: 'hi', complete: true }} />);
  expect(screen.queryByText('已引导')).toBeNull();
});

test('the stopped marker renders as "Stopped" with an accessible label', async () => {
  await render(<MessageRow item={{ key: 'i2', role: 'status', text: '已停止', marker: 'stopped' }} />);
  expect(screen.getByLabelText('回复已停止')).toBeOnTheScreen();
  expect(screen.getByText('已停止')).toBeOnTheScreen();
});

describe('tool row outcome', () => {
  const tool = (outcome?: 'ok' | 'failed' | 'denied' | 'interrupted') => ({
    key: 't1', role: 'tool' as const, text: 'terminal',
    tool: { id: 't1', name: 'terminal', running: false, ...(outcome ? { outcome } : {}) },
  });

  /** The theme the row renders with (the test scheme), read through the same hook. */
  async function themeColors(): Promise<ThemeColors> {
    let colors: ThemeColors | null = null;
    function Probe() {
      colors = useTheme().colors;
      return null;
    }
    await render(<Probe />);
    return colors!;
  }

  test.each([
    [undefined, '工具 terminal，已完成', 'checkmark.circle.fill', 'success'],
    ['ok', '工具 terminal，已完成', 'checkmark.circle.fill', 'success'],
    ['failed', '工具 terminal，失败', 'xmark.circle.fill', 'danger'],
    ['denied', '工具 terminal，已拒绝', 'hand.raised.fill', 'textDim'],
    ['interrupted', '工具 terminal，已中断', 'stop.circle.fill', 'textDim'],
  ] as const)('outcome %s → "%s", %s in %s', async (outcome, label, sf, token) => {
    const colors = await themeColors();
    mockIcon.mockClear();
    await render(<MessageRow item={tool(outcome)} />);
    expect(screen.getByLabelText(label)).toBeOnTheScreen();
    const marks = mockIcon.mock.calls.map(([p]) => p).filter((p) => p.sf !== 'hammer.fill');
    expect(marks).toEqual([expect.objectContaining({ sf, color: colors[token] })]);
  });

  test('a finished row with a summary reads it out after the outcome', async () => {
    const item = tool('denied');
    const summary = 'No answer within 60s — the command did not run.';
    await render(<MessageRow item={{ ...item, tool: { ...item.tool, summary } }} />);
    expect(screen.getByLabelText(`工具 terminal，已拒绝, ${summary}`)).toBeOnTheScreen();
  });

  test("a summary's closing period does not run into the details hint", async () => {
    const item = tool('denied');
    const summary = 'You denied this command — it did not run.';
    await render(<MessageRow item={{ ...item, tool: { ...item.tool, summary, detail: 'BLOCKED' } }} />);
    expect(
      screen.getByLabelText('工具 terminal，已拒绝, You denied this command — it did not run，查看详情'),
    ).toBeOnTheScreen();
  });

  test('a running tool still says running', async () => {
    await render(<MessageRow item={{ ...tool(), tool: { id: 't1', name: 'terminal', running: true } }} />);
    expect(screen.getByLabelText('工具 terminal，运行中')).toBeOnTheScreen();
  });
});
