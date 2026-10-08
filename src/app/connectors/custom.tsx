// src/app/connectors/custom.tsx
//
// Add a remote MCP server by URL (spec §5.5): no auth, a bearer token, or OAuth.
//
// A bearer token is typed into ConnectorSecretForm, which owns it and runs Face ID before
// it is sent (spec §5.9); this screen never holds it. The form is keyed by the
// authentication choice, so switching away from "Bearer token" drops what was typed.
// The gateway does the real validation; the checks here only save a round trip.
import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { addMcpServer, listMcpServers, type McpAddBody } from '@/api/mcp';
import { HttpError } from '@/api/restClient';
import { ConnectorSecretForm, type SubmitResult } from '@/components/connector-secret-form';
import { gatewayBaseUrl, requestSignInOnOpen } from '@/components/connector-sign-in';
import { withAuthRetry } from '@/connection';
import {
  connectorError,
  gatewaySupportsOauth,
  isCustomServerValid,
  sameServerAddress,
  suggestServerName,
  validateCustomServer,
  type CustomServerDraft,
  type SecretField,
} from '@/lib/mcp';
import { getProfileState, subscribeProfiles } from '@/profile-store';
import { markMcpChanged } from '@/session-mcp-store';
import { useTheme, type ThemeColors } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

type Auth = CustomServerDraft['auth'];

const AUTH_CHOICES: { value: Auth; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'header', label: 'Bearer 令牌' },
  { value: 'oauth', label: 'OAuth' },
];

const TOKEN_FIELD: SecretField = { key: 'token', label: '令牌', masked: true, required: true };
const NO_FIELDS: SecretField[] = [];

function inputStyle(colors: ThemeColors, fontScale: number) {
  return {
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderCurve: 'continuous' as const,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    minHeight: 44,
    paddingVertical: Math.round(10 * Math.min(fontScale, 2)),
    fontSize: 16,
  };
}

function Label({ children }: { children: string }) {
  const { colors } = useTheme();
  return <Text style={{ color: colors.textDim, fontSize: 13, fontWeight: '600' }}>{children}</Text>;
}

function Issue({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <Text accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 13 }}>
      {children}
    </Text>
  );
}

export default function CustomConnectorScreen() {
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const profiles = useSyncExternalStore(subscribeProfiles, getProfileState);
  const profile = profiles.selected;
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  // The name follows the URL until he types one himself.
  const [nameEdited, setNameEdited] = useState(false);
  const [auth, setAuth] = useState<Auth>('none');
  const [showIssues, setShowIssues] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Shown when the add succeeded while he was on another screen (no automatic navigation then).
  const [added, setAdded] = useState(false);
  // After an await, a screen that was left must not navigate or write state.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A late answer may navigate only while this screen is the one he is looking at. Mounted is
  // not enough: a chat pushed on top (a notification tap) leaves this screen mounted, and
  // `dismissTo` would then pop that chat.
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );

  // The token's presence is the form's own check (it owns the token), hence hasToken: true.
  const issues = validateCustomServer({ name, url, auth, hasToken: true });
  const base = gatewayBaseUrl();
  const oauthBlocked = auth === 'oauth' && !(base && gatewaySupportsOauth(base));

  function changeUrl(text: string) {
    setUrl(text);
    if (!nameEdited) setName(suggestServerName(text));
  }

  function changeName(text: string) {
    setNameEdited(true);
    setName(text);
  }

  /** The connector exists on the gateway because of this screen: note it, then go to it. */
  function finish(addedName: string) {
    markMcpChanged(); // the running gateway does not have it yet: the list offers a reload
    if (!focused.current) {
      // He is elsewhere: do not pull him back, and do not queue a sign-in page for later.
      if (mounted.current) setAdded(true);
      return;
    }
    if (auth === 'oauth') requestSignInOnOpen(addedName);
    router.dismissTo('/connectors');
    router.push({ pathname: '/connectors/server/[name]', params: { name: addedName } });
  }

  /** ConnectorSecretForm hands over the token here, after Face ID. It goes into the request
   * body and nowhere else. */
  async function add(values: Record<string, string>): Promise<SubmitResult> {
    const handled: SubmitResult = { ok: false, message: '' };
    const serverName = name.trim();
    const serverUrl = url.trim();
    const body: McpAddBody =
      auth === 'header'
        ? { name: serverName, url: serverUrl, auth, bearer_token: values.token ?? '' }
        : { name: serverName, url: serverUrl, auth };
    setSubmitting(true);
    try {
      const created = await withAuthRetry((r) => addMcpServer(r, body, profile));
      finish(created.name);
      return { ok: true };
    } catch (e) {
      if (!mounted.current) return handled;
      const mapped = connectorError(e, 'add');
      if (mapped.kind === 'auth') {
        router.replace('/');
        return handled;
      }
      // No answer came back (a timeout, the network): the gateway may have added it. Look
      // before he retries — and adopt what is there only if it is the server just submitted.
      if (!(e instanceof HttpError) || e.status === 0) {
        const found = await withAuthRetry((r) => listMcpServers(r, profile))
          .then((list) => list.find((s) => s.name === serverName) ?? null)
          .catch(() => null);
        if (!mounted.current) return handled;
        if (found && sameServerAddress(found, serverUrl)) {
          finish(found.name);
          return { ok: true };
        }
      }
      return { ok: false, message: mapped.message };
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <ScrollView
      testID="connector-custom"
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 40 }}
    >
      <Stack.Screen options={{ title: '自定义服务器' }} />

      <View style={{ gap: 6 }}>
        <Label>服务器地址</Label>
        <TextInput
          value={url}
          onChangeText={changeUrl}
          editable={!submitting}
          keyboardType="url"
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          textContentType="URL"
          placeholder="https://example.com/mcp"
          placeholderTextColor={colors.placeholder}
          accessibilityLabel="服务器地址"
          style={inputStyle(colors, fontScale)}
        />
        {showIssues && issues.url ? <Issue>{issues.url}</Issue> : null}
        {issues.caution ? <Text style={{ color: colors.textDim, fontSize: 13 }}>{issues.caution}</Text> : null}
      </View>

      <View style={{ gap: 6 }}>
        <Label>名称</Label>
        <TextInput
          value={name}
          onChangeText={changeName}
          editable={!submitting}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          placeholder="智能体使用的名称"
          placeholderTextColor={colors.placeholder}
          accessibilityLabel="名称"
          style={inputStyle(colors, fontScale)}
        />
        {showIssues && issues.name ? <Issue>{issues.name}</Issue> : null}
      </View>

      <View style={{ gap: 6 }}>
        <Label>身份验证</Label>
        <View accessibilityRole="radiogroup" accessibilityLabel="身份验证" style={{ flexDirection: 'row', gap: 8 }}>
          {AUTH_CHOICES.map((choice) => {
            const selected = auth === choice.value;
            return (
              <Pressable
                key={choice.value}
                accessibilityRole="radio"
                accessibilityLabel={choice.label}
                accessibilityState={{ checked: selected, disabled: submitting }}
                disabled={submitting}
                onPress={() => setAuth(choice.value)}
                style={{
                  flex: 1,
                  minHeight: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingHorizontal: 8,
                  borderRadius: 12,
                  borderCurve: 'continuous',
                  borderWidth: 1,
                  borderColor: selected ? colors.accent : colors.border,
                  backgroundColor: selected ? colors.raised : 'transparent',
                  opacity: submitting ? 0.45 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: selected ? '700' : '500' }}>
                  {choice.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {auth === 'oauth' ? (
          oauthBlocked ? (
            <Issue>OAuth 登录需要网关使用 HTTPS 地址。</Issue>
          ) : (
            <Text style={{ color: colors.textDim, fontSize: 13 }}>

              添加后将打开连接器，并跳转到提供商的登录页面。
            </Text>
          )
        ) : null}
      </View>

      {added ? (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.textDim, fontSize: 14 }}>

          已添加，可从连接器列表打开。
        </Text>
      ) : null}

      <ConnectorSecretForm
        key={auth}
        fields={auth === 'header' ? [TOKEN_FIELD] : NO_FIELDS}
        submitLabel="添加连接器"
        beforeSubmit={() => {
          setShowIssues(true);
          return isCustomServerValid(issues) && !oauthBlocked;
        }}
        onSubmit={add}
      />

      <Text style={{ color: colors.textFaint, fontSize: 12.5, marginHorizontal: 4 }}>

        添加后，网关上的智能体可以连接此地址。重新加载连接器或重启网关后生效。
      </Text>
    </ScrollView>
  );
}
