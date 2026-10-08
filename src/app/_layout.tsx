import { Stack, ThemeProvider, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SidebarHost } from '@/components/sidebar-host';
import { setupNotificationHandling } from '@/notifications';
import { routeForPushData } from '@/lib/push';
import { navigationTheme, useTheme } from '@/theme';

export default function Layout() {
  const { colors, dark } = useTheme();

  // Foreground banners; a tap deep-links to the session the push concerns
  // (claimed sessions carry data.session_id), else the chat home. Cold-start
  // taps are handled in the connect screen's restore (index.tsx).
  useEffect(
    () =>
      setupNotificationHandling((data) =>
        router.navigate(routeForPushData(data) as Parameters<typeof router.navigate>[0]),
      ),
    [],
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      {/* The navigator's own theme must match the app's, or iOS 26 draws the header's glass
          items for the wrong appearance (see navigationTheme). */}
      <ThemeProvider value={navigationTheme(colors, dark)}>
        <SidebarHost>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.accent,
              headerTitleStyle: { color: colors.text },
              headerShadowVisible: false,
              headerBackButtonDisplayMode: 'minimal',
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            {/* Chat is the root surface: no native header (floating buttons
                instead) and no back-swipe — the left edge opens the sidebar.
                Crossfade between chats instead of a hard cut. */}
            <Stack.Screen
              name="chat/[id]"
              options={{ headerShown: false, gestureEnabled: false, animation: 'fade' }}
            />
            <Stack.Screen
              name="attach"
              options={{
                presentation: 'formSheet',
                sheetGrabberVisible: true,
                sheetAllowedDetents: 'fitToContents',
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="settings"
              options={{
                title: '设置',
                presentation: 'formSheet',
                sheetGrabberVisible: true,
                sheetAllowedDetents: [0.5, 1.0],
                headerShown: false,
              }}
            />
          </Stack>
        </SidebarHost>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
