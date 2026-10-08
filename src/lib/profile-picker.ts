// Shared "Switch profile" action sheet — used by the sidebar and the
// add-to-chat sheet. Cross-platform via the action-sheet helper.
import * as Haptics from 'expo-haptics';
import { showActionSheet } from '@/lib/action-sheet';
import { getProfileState, setSelectedProfile } from '@/profile-store';

export function showProfilePicker(): void {
  const { names, selected, serverCurrent } = getProfileState();
  const current = selected ?? serverCurrent;
  const pick = (name: string) => {
    if (name === current) return;
    Haptics.selectionAsync();
    void setSelectedProfile(name);
  };
  showActionSheet(
    '切换配置档案',
    names.map((n) => ({
      label: n === current ? `${n} ✓` : n,
      onPress: () => pick(n),
    })),
  );
}
