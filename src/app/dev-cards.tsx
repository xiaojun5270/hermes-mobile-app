// src/app/dev-cards.tsx
//
// __DEV__-only gallery of the turn-control UI in every state, for simulator screenshots in both
// themes: `xcrun simctl openurl booted hermesmobileapp://dev-cards`. Release builds redirect away.
import { Redirect } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApprovalCard } from '@/components/approval-card';
import { ClarifyCard } from '@/components/clarify-card';
import { Composer } from '@/components/composer';
import { MessageRow } from '@/components/message-row';
import { SecureEntryCard } from '@/components/secure-entry-card';
import { VaultDeclinedNote } from '@/components/vault-declined-note';
import type { ComposerMode, RequestCardState } from '@/lib/turn-controller';
import { useTheme } from '@/theme';

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.textFaint, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' }}>{title}</Text>
      {children}
    </View>
  );
}

function devCard(over: Partial<RequestCardState> & Pick<RequestCardState, 'id' | 'kind' | 'method' | 'params'>): RequestCardState {
  return { status: 'pending', legacy: false, receivedAt: Date.now(), anchorKey: null, ...over };
}
const devApproval = { session_id: 's', request_id: 'r', command: 'rm -rf build/ dist/', description: 'Recursive delete of two directories', pattern_key: 'recursive delete', choices: ['once', 'session', 'always', 'deny'] };
const devClarifyResponder = {
  clarifySingle: () => ({ ok: true as const }),
  clarifyLock: async () => 'ok' as const,
  clarifySubmitAll: async () => 'resolved' as const,
  clarifySkipAll: () => ({ ok: true as const }),
};
const devBatch = {
  session_id: 's',
  questions: [
    { qid: 'q0', question: 'Which environment should I deploy to?', choices: ['staging (Recommended)', 'production'], multi_select: false },
    { qid: 'q1', question: 'Which checks should run first?', choices: ['unit', 'lint', 'e2e'], multi_select: true },
    { qid: 'q2', question: 'Anything I should avoid?', choices: null, multi_select: false },
  ],
};

function DevComposer({ mode, initial = '', image = false }: { mode: ComposerMode; initial?: string; image?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <Composer
      value={value}
      onChangeText={setValue}
      mode={mode}
      onSend={() => {}}
      onStop={() => {}}
      onSteer={() => {}}
      stagedImageUri={image ? 'https://picsum.photos/seed/hermes/128' : null}
    />
  );
}

export default function DevCards() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 40, gap: 24 }}
    >
      <Section title="会话标记">
        <MessageRow item={{ key: 'd1', role: 'user', text: 'Actually, use tabs.', complete: true, steered: true }} />
        <MessageRow item={{ key: 'd2', role: 'status', text: '已停止', marker: 'stopped' }} />
      </Section>
      <Section title="消息输入">
        <DevComposer mode={{ kind: 'send', enabled: false }} />
        <DevComposer mode={{ kind: 'stop+steer', stopEnabled: true, steerEnabled: false }} />
        <DevComposer mode={{ kind: 'stop+steer', stopEnabled: true, steerEnabled: true }} initial="Actually, use tabs." />
        <DevComposer mode={{ kind: 'stop+steer', stopEnabled: false, steerEnabled: false }} initial="Actually, use tabs." />
        <DevComposer mode={{ kind: 'stop+steer', stopEnabled: true, steerEnabled: false }} image />
      </Section>
      <Section title="操作授权">
        <ApprovalCard card={devCard({ id: 'a1', kind: 'approval', method: 'approval', params: devApproval })} actionable onRespond={() => {}} />
        <ApprovalCard card={devCard({ id: 'a2', kind: 'approval', method: 'approval', params: devApproval, legacy: true })} actionable={false} onRespond={() => {}} />
        <ApprovalCard card={devCard({ id: 'a3', kind: 'approval', method: 'approval', params: devApproval, status: 'answered', resolution: 'deny' })} actionable={false} onRespond={() => {}} />
        <ApprovalCard card={devCard({ id: 'a5', kind: 'approval', method: 'approval', params: devApproval, status: 'answered', resolution: 'session' })} actionable={false} onRespond={() => {}} />
        <ApprovalCard card={devCard({ id: 'a6', kind: 'approval', method: 'approval', params: devApproval, status: 'answered', resolution: 'always' })} actionable={false} onRespond={() => {}} />
        <ApprovalCard card={devCard({ id: 'a7', kind: 'approval', method: 'approval', params: { ...devApproval, choices: ['once', 'deny'] } })} actionable onRespond={() => {}} />
        <ApprovalCard card={devCard({ id: 'a4', kind: 'approval', method: 'approval', params: devApproval, status: 'cancelled', cancelReason: 'interrupted' })} actionable={false} onRespond={() => {}} />
      </Section>
      <Section title="问题确认">
        <ClarifyCard
          card={devCard({ id: 'c1', kind: 'clarify', method: 'clarify', params: { session_id: 's', question: 'Tabs or spaces?', choices: ['Tabs (Recommended)', 'Spaces'] } })}
          responder={devClarifyResponder}
        />
        <ClarifyCard
          card={devCard({ id: 'c2', kind: 'clarify', method: 'clarify', params: devBatch, lockedAnswers: { q0: 'staging' } })}
          responder={devClarifyResponder}
        />
        <ClarifyCard
          card={devCard({ id: 'c3', kind: 'clarify', method: 'clarify', params: { session_id: 's', question: 'Why?', choices: null }, status: 'cancelled', cancelReason: 'timeout' })}
          responder={devClarifyResponder}
        />
      </Section>
      <Section title="安全输入">
        <SecureEntryCard
          card={devCard({
            id: 's1',
            kind: 'secure-entry',
            method: 'secret',
            params: { session_id: 's', env_var: 'OPENWEATHER_API_KEY', prompt: 'Your OpenWeather API key (free tier is fine)', metadata: { skill_name: 'weather' } },
          })}
          provenance="agent"
          onSend={() => {}}
          onSkip={() => {}}
        />
        <SecureEntryCard
          card={devCard({ id: 's2', kind: 'secure-entry', method: 'sudo', params: { session_id: 's', command: 'apt-get install -y jq' } })}
          provenance={null}
          onSend={() => {}}
          onSkip={() => {}}
        />
        <SecureEntryCard
          card={devCard({ id: 's3', kind: 'secure-entry', method: 'secret', params: { session_id: 's', env_var: 'K', prompt: 'p' }, status: 'answered' })}
          provenance="unknown"
          onSend={() => {}}
          onSkip={() => {}}
        />
      </Section>
      <Section title="凭据保管">
        <VaultDeclinedNote />
      </Section>
      {/* dev-cards:end */}
    </ScrollView>
  );
}
