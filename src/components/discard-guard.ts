// src/components/discard-guard.ts
//
// Asks "Discard changes?" before a screen with unsaved edits is removed (header back,
// router.back). Keep editing leaves the screen where it is; Discard lets the navigation go.
//
// usePreventRemove, not a bare `beforeRemove` listener: native-stack only honours prevention it
// knows about up front. With a bare listener UIKit has already popped the screen when the header
// back fires ("removed natively but didn't get removed from JS state"), so Keep editing could not
// keep you there. usePreventRemove marks the route prevented, which sets preventNativeDismiss and
// turns off the long-press back menu, so the removal reaches JS first. (SDK 58 re-exports it from
// 'expo-router' itself; on SDK 56/57 it lives in expo-router's bundled react-navigation.)
import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { Alert } from 'react-native';

export function useDiscardGuard(dirty: boolean, message: string): void {
  const navigation = useNavigation();
  usePreventRemove(dirty, ({ data }) => {
    Alert.alert('放弃修改？', message, [
      { text: '继续编辑', style: 'cancel' },
      { text: '放弃修改', style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ]);
  });
}
