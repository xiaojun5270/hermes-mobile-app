// __tests__/action-sheet.test.ts
// babel-preset-expo inlines process.env.EXPO_OS at transform time (always
// 'ios' under jest-expo's default platform), so the Android branch is
// exercised through the platform-explicit showActionSheetOn export.
import { ActionSheetIOS, Alert, type AlertButton } from 'react-native';
import { showActionSheet, showActionSheetOn, type SheetAction } from '../src/lib/action-sheet';

const sheetSpy = jest
  .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
  .mockImplementation(() => {});
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

beforeEach(() => {
  sheetSpy.mockClear();
  alertSpy.mockClear();
});

function makeActions(): SheetAction[] {
  return [
    { label: '文本', onPress: jest.fn() },
    { label: 'JSONL', onPress: jest.fn() },
    { label: '删除', destructive: true, onPress: jest.fn() },
  ];
}

describe('showActionSheet (build-time platform, ios under jest)', () => {
  it('routes to the native iOS sheet', () => {
    showActionSheet('Pick one', makeActions());
    expect(sheetSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('showActionSheetOn ios', () => {
  it('passes labels in order with a trailing Cancel and correct indices', () => {
    showActionSheetOn('ios', 'Pick one', makeActions());
    expect(sheetSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(sheetSpy.mock.calls[0][0]).toEqual({
      title: 'Pick one',
      options: ['文本', 'JSONL', '删除', '取消'],
      cancelButtonIndex: 3,
      destructiveButtonIndex: 2,
    });
  });

  it('omits destructiveButtonIndex when no action is destructive', () => {
    showActionSheetOn('ios', '导出会话', [
      { label: '文本', onPress: jest.fn() },
      { label: 'JSONL', onPress: jest.fn() },
    ]);
    const [opts] = sheetSpy.mock.calls[0];
    expect(opts.destructiveButtonIndex).toBeUndefined();
    expect(opts.cancelButtonIndex).toBe(2);
  });

  it('selecting index N invokes action N; Cancel invokes none', () => {
    const actions = makeActions();
    showActionSheetOn('ios', undefined, actions);
    const onSelect = sheetSpy.mock.calls[0][1];
    onSelect(1);
    expect(actions[0].onPress).not.toHaveBeenCalled();
    expect(actions[1].onPress).toHaveBeenCalledTimes(1);
    expect(actions[2].onPress).not.toHaveBeenCalled();
    onSelect(3); // cancel
    expect(actions[0].onPress).not.toHaveBeenCalled();
    expect(actions[1].onPress).toHaveBeenCalledTimes(1);
    expect(actions[2].onPress).not.toHaveBeenCalled();
  });
});

describe('showActionSheetOn android', () => {
  it('builds an Alert with the actions in order plus a cancel button', () => {
    showActionSheetOn('android', 'Pick one', makeActions());
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(sheetSpy).not.toHaveBeenCalled();
    const [title, message, buttons] = alertSpy.mock.calls[0] as [
      string,
      string | undefined,
      AlertButton[],
    ];
    expect(title).toBe('Pick one');
    expect(message).toBeUndefined();
    expect(buttons.map((b) => b.text)).toEqual(['文本', 'JSONL', '删除', '取消']);
    expect(buttons[0].style).toBeUndefined();
    expect(buttons[2].style).toBe('destructive');
    expect(buttons[3].style).toBe('cancel');
  });

  it('pressing button N invokes action N', () => {
    const actions = makeActions();
    showActionSheetOn('android', 'Pick one', actions);
    const buttons = alertSpy.mock.calls[0][2] as AlertButton[];
    buttons[1].onPress?.();
    expect(actions[0].onPress).not.toHaveBeenCalled();
    expect(actions[1].onPress).toHaveBeenCalledTimes(1);
    expect(actions[2].onPress).not.toHaveBeenCalled();
  });

  it('falls back to an empty title when none is given', () => {
    showActionSheetOn('android', undefined, makeActions());
    expect(alertSpy.mock.calls[0][0]).toBe('');
  });
});
