// Cross-platform action sheet: native ActionSheetIOS on iOS (unchanged
// behavior), an Alert-based menu on Android.
import { ActionSheetIOS, Alert } from 'react-native';

export interface SheetAction {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

const isIOS = process.env.EXPO_OS === 'ios';

/** Native action sheet on iOS; Alert-based menu elsewhere. */
export function showActionSheet(title: string | undefined, actions: SheetAction[]) {
  showActionSheetOn(isIOS ? 'ios' : 'android', title, actions);
}

/** Platform-explicit variant. `process.env.EXPO_OS` is inlined at build time
 * (babel-preset-expo), so tests inject the platform here instead. */
export function showActionSheetOn(
  platform: 'ios' | 'android',
  title: string | undefined,
  actions: SheetAction[],
) {
  if (platform === 'ios') {
    const options = [...actions.map((a) => a.label), '取消'];
    const destructive = actions.findIndex((a) => a.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options,
        cancelButtonIndex: options.length - 1,
        destructiveButtonIndex: destructive >= 0 ? destructive : undefined,
      },
      (index) => {
        if (index < actions.length) actions[index].onPress();
      },
    );
    return;
  }
  Alert.alert(title ?? '', undefined, [
    ...actions.map((a) => ({
      text: a.label,
      style: a.destructive ? ('destructive' as const) : undefined,
      onPress: a.onPress,
    })),
    { text: '取消', style: 'cancel' as const },
  ]);
}
