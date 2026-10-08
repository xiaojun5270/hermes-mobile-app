/* eslint-disable react-hooks/immutability --
 * Reanimated shared values are mutated via `.value` inside worklets (UI
 * thread); the compiler-backed rule misreads these as render mutations. */
import { usePathname } from 'expo-router';
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { BackHandler, Keyboard, Pressable, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Sidebar } from '@/components/sidebar';
import { isSidebarOpen, setSidebarOpen, subscribeSidebar } from '@/sidebar-store';
import { useTheme } from '@/theme';

// Critically-damped spring: settles fast with no overshoot (overshoot past 1
// would pull the panel beyond the drawer edge). Velocity carries over from
// the pan gesture, so a flick lands with momentum instead of a fixed curve.
const SPRING = { damping: 32, stiffness: 320, mass: 1, overshootClamping: true };
const EDGE_WIDTH = 24;

/**
 * Claude-style slide-over: the sidebar sits beneath the main content, and
 * opening pushes the whole navigator to the right with a rounded corner and
 * a drop shadow, leaving a tappable sliver. Active only on chat routes, so
 * the iOS back-swipe on pushed screens keeps the left edge elsewhere.
 */
export function SidebarHost({ children }: { children: ReactNode }) {
  // Reanimated shared-value writes inside worklets look like render-time
  // mutations to the React Compiler — opt out; memoization here is manual.
  'use no memo';
  const { colors, dark } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const pathname = usePathname();
  const open = useSyncExternalStore(subscribeSidebar, isSidebarOpen);
  const enabled = pathname.startsWith('/chat');
  const drawerWidth = Math.min(Math.round(screenWidth * 0.82), 340);
  const progress = useSharedValue(0);

  // Leaving the chat area (settings, cron, connect …) always closes the drawer.
  useEffect(() => {
    if (!enabled && open) setSidebarOpen(false);
  }, [enabled, open]);

  useEffect(() => {
    if (open) Keyboard.dismiss();
    progress.value = withSpring(open ? 1 : 0, SPRING);
  }, [open, progress]);

  // Android hardware/gesture back closes the drawer instead of popping the
  // chat route. BackHandler never fires on iOS, but gate anyway for symmetry.
  useEffect(() => {
    if (process.env.EXPO_OS === 'ios' || !open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSidebarOpen(false);
      return true; // consume: do not pop the chat route
    });
    return () => sub.remove();
  }, [open]);

  const settle = (shouldOpen: boolean, velocityX: number) => {
    'worklet';
    progress.value = withSpring(shouldOpen ? 1 : 0, {
      ...SPRING,
      velocity: velocityX / drawerWidth,
    });
    runOnJS(setSidebarOpen)(shouldOpen);
  };

  const openGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(10)
        .failOffsetY([-14, 14])
        .onUpdate((e) => {
          progress.value = Math.min(Math.max(e.translationX / drawerWidth, 0), 1);
        })
        .onEnd((e) => {
          settle(progress.value > 0.3 || e.velocityX > 500, e.velocityX);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawerWidth],
  );

  const closeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-10, 10])
        .failOffsetY([-14, 14])
        .onUpdate((e) => {
          progress.value = Math.min(Math.max(1 + e.translationX / drawerWidth, 0), 1);
        })
        .onEnd((e) => {
          settle(!(progress.value < 0.7 || e.velocityX < -500), e.velocityX);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawerWidth],
  );

  const mainStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * drawerWidth }],
    borderRadius: progress.value * 30,
  }));

  const drawerStyle = useAnimatedStyle(() => ({
    // Slight parallax so the panel feels anchored beneath the content.
    transform: [{ translateX: -0.3 * drawerWidth * (1 - progress.value) }],
    opacity: 0.4 + 0.6 * progress.value,
  }));

  return (
    <View style={{ flex: 1, backgroundColor: colors.sidebarBg }}>
      {/* The drawer stays mounted at all times: unmounting it while the close
          animation is still running orphans the swipeable rows' native views
          (Reanimated retains them and repaints at the screen origin). Closed,
          it is fully covered by the opaque main panel and ignores touches. */}
      <Animated.View
        pointerEvents={open ? 'auto' : 'none'}
        style={[
          { position: 'absolute', top: 0, bottom: 0, left: 0, width: drawerWidth },
          drawerStyle,
        ]}
      >
        <Sidebar open={open} width={drawerWidth} />
      </Animated.View>

      <Animated.View
        style={[
          {
            flex: 1,
            overflow: 'hidden',
            borderCurve: 'continuous',
            backgroundColor: colors.bg,
            boxShadow: dark ? '0 0 40px rgba(0, 0, 0, 0.55)' : '0 0 40px rgba(31, 30, 26, 0.22)',
          },
          mainStyle,
        ]}
      >
        {children}
      </Animated.View>

      {/* Left-edge pan opens the drawer on chat screens. */}
      {enabled && !open ? (
        <GestureDetector gesture={openGesture}>
          <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: EDGE_WIDTH }} />
        </GestureDetector>
      ) : null}

      {/* The pushed-aside sliver: tap or drag left to close. */}
      {enabled && open ? (
        <GestureDetector gesture={closeGesture}>
          <View style={{ position: 'absolute', top: 0, bottom: 0, left: drawerWidth, right: 0 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭菜单"
              onPress={() => setSidebarOpen(false)}
              style={{ flex: 1 }}
            />
          </View>
        </GestureDetector>
      ) : null}
    </View>
  );
}
