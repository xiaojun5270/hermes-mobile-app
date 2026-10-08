// src/components/clarify-card.tsx — the agent's clarify question(s) (spec §6.2).
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View, type HostInstance } from 'react-native';
import { CardButton } from '@/components/card-button';
import { Icon } from '@/components/icon';
import {
  EMPTY_DRAFT,
  clarifyView,
  draftAnswer,
  lockedAnswerLabel,
  setOther,
  toggleChoice,
  type ClarifyDraft,
  type ClarifyQuestionView,
} from '@/lib/clarify';
import type { ClarifyAnswer, RequestResponder } from '@/lib/request-answers';
import { cancelLabel, type RequestCardState } from '@/lib/turn-controller';
import { useTheme } from '@/theme';

export type ClarifyResponder = Pick<RequestResponder, 'clarifySingle' | 'clarifyLock' | 'clarifySubmitAll' | 'clarifySkipAll'>;

function SettledRow({ card }: { card: RequestCardState }) {
  const { colors } = useTheme();
  if (card.status === 'answering') {
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: 32,
        }}
      >
        <ActivityIndicator size="small" color={colors.textDim} />
        <Text style={{ color: colors.textDim, fontSize: 13.5 }}>正在发送…</Text>
      </View>
    );
  }
  const label =
    card.status === 'cancelled'
      ? card.cancelReason
        ? cancelLabel(card.cancelReason)
        : '已关闭'
      : card.status === 'skipped'
        ? '已跳过'
        : card.resolution
          ? `已回答：${card.resolution}`
          : '已回答';
  const answered = card.status === 'answered';
  return (
    <View
      accessibilityLabel={`问题 ${label}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <Icon
        sf={answered ? 'checkmark.circle.fill' : 'slash.circle'}
        size={14}
        color={answered ? colors.success : colors.textFaint}
      />
      <Text
        style={{
          color: answered ? colors.success : colors.textFaint,
          fontSize: 13.5,
          fontWeight: '600',
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function QuestionBlock(props: {
  q: ClarifyQuestionView;
  index: number;
  batch: boolean;
  draft: ClarifyDraft;
  onChange: (d: ClarifyDraft) => void;
  locked: boolean;
  lockedAnswer: unknown;
  /** The card is no longer open: the question reads as a summary, with no field or buttons (V3). */
  settled: boolean;
  disabled: boolean;
  onSkip: () => void;
  onConfirm: (answer: ClarifyAnswer) => void;
  onInputFocus?: (measureField: HostInstance['measureInWindow']) => void;
}) {
  const { q, index, batch, draft, onChange, locked, lockedAnswer, settled, disabled, onSkip, onConfirm, onInputFocus } = props;
  const { colors } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const n = index + 1;
  const forQ = batch ? `，问题 ${n}` : '';
  // Batch questions keep their number in every state (V5).
  const heading = `${batch ? `${n}. ` : ''}${q.question}`;
  if (settled && !locked) {
    return <Text style={{ color: colors.textDim, fontSize: 14, lineHeight: 20 }}>{heading}</Text>;
  }
  if (locked) {
    const label = lockedAnswerLabel(lockedAnswer);
    return (
      <View accessibilityLabel={`问题 ${n}已回答：${label || '已跳过'}`} style={{ gap: 4 }}>
        <Text style={{ color: colors.textDim, fontSize: 14, lineHeight: 20 }}>{heading}</Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Icon sf="checkmark.circle.fill" size={13} color={colors.success} />
          <Text
            style={{
              color: colors.text,
              fontSize: 14,
              fontWeight: '600',
              flexShrink: 1,
            }}
          >
            {label || '已跳过'}
          </Text>
        </View>
      </View>
    );
  }
  const answer = draftAnswer(q, draft);
  return (
    <View style={{ gap: 6 }}>
      <Text
        style={{
          color: colors.text,
          fontSize: 15,
          lineHeight: 21,
          fontWeight: '600',
        }}
      >
        {heading}
      </Text>
      {q.choices?.map((c) => {
        const on = draft.selected.includes(c.label);
        return (
          <Pressable
            key={c.label}
            accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: on, disabled }}
            accessibilityLabel={`${c.label}${c.recommended ? '，推荐' : ''}`}
            disabled={disabled}
            onPress={() => onChange(toggleChoice(q, draft, c.label))}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              minHeight: 44,
              paddingHorizontal: 10,
              borderRadius: 10,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: on ? colors.accent : colors.border,
              backgroundColor: pressed ? colors.surface : 'transparent',
            })}
          >
            <Icon
              sf={q.multiSelect ? (on ? 'checkmark.square.fill' : 'square') : on ? 'largecircle.fill.circle' : 'circle'}
              size={18}
              color={on ? colors.accent : colors.textFaint}
            />
            <Text style={{ color: colors.text, fontSize: 15, flexShrink: 1 }}>{c.label}</Text>
            {c.recommended ? (
              <View
                style={{
                  borderRadius: 6,
                  borderCurve: 'continuous',
                  borderWidth: 1,
                  borderColor: colors.accent,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                }}
              >
                <Text style={{ color: colors.accent, fontSize: 11, fontWeight: '700' }}>推荐</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
      <TextInput
        value={draft.other}
        onChangeText={(t) => onChange(setOther(q, draft, t))}
        ref={inputRef}
        onFocus={() => onInputFocus?.((cb) => inputRef.current?.measureInWindow(cb))}
        editable={!disabled}
        multiline
        placeholder={q.choices ? '其他…' : '你的回答'}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={q.choices ? `其他回答${forQ}` : `回答${forQ}`}
        style={{
          color: colors.text,
          backgroundColor: colors.surface,
          borderRadius: 10,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: colors.border,
          paddingHorizontal: 10,
          paddingTop: 10,
          paddingBottom: 10,
          fontSize: 15,
          maxHeight: 100,
        }}
      />
      {batch ? (
        <View
          style={{
            flexDirection: 'row',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          <CardButton label="跳过" a11y={`跳过问题 ${n}`} onPress={onSkip} disabled={disabled} />
          <CardButton
            label="确认"
            a11y={`确认问题的回答 ${n}`}
            onPress={() => answer !== null && onConfirm(answer)}
            disabled={disabled || answer === null}
          />
        </View>
      ) : null}
    </View>
  );
}

export function ClarifyCard({
  card,
  responder,
  onInputFocus,
}: {
  card: RequestCardState;
  responder: ClarifyResponder;
  /** A text field got focus: the screen measures that field (not the card) and scrolls it above the keyboard. */
  onInputFocus?: (measureField: HostInstance['measureInWindow']) => void;
}) {
  const { colors } = useTheme();
  const view = clarifyView(card.params);
  const [drafts, setDrafts] = useState<Record<string, ClarifyDraft>>({});
  const [busy, setBusy] = useState(false);
  // `openOnly`: a failed lock's "Try again" means nothing once the card is closed (final review m6).
  const [note, setNote] = useState<{ text: string; openOnly: boolean } | null>(null);
  const pending = card.status === 'pending';
  const locked = card.lockedAnswers ?? {};
  const draftOf = (qid: string) => drafts[qid] ?? EMPTY_DRAFT;
  const setDraft = (qid: string, d: ClarifyDraft) => setDrafts((prev) => ({ ...prev, [qid]: d }));

  async function lock(qid: string, answer: ClarifyAnswer) {
    setBusy(true);
    setNote(null);
    const out = await responder.clarifyLock(card, qid, answer);
    setBusy(false);
    if (out === 'failed') setNote({ text: '无法发送回答，请重试。', openOnly: true });
  }

  async function submitAll() {
    if (view === null) return;
    const answers = view.questions
      .filter((q) => !(q.qid in locked))
      .map((q) => ({ qid: q.qid, answer: draftAnswer(q, draftOf(q.qid)) ?? '' }));
    setBusy(true);
    setNote(null);
    const out = await responder.clarifySubmitAll(card, answers);
    setBusy(false);
    if (out === 'failed') setNote({ text: '部分回答未能发送，请重试。', openOnly: true });
  }

  function finish(result: { ok: true } | { ok: false; message: string }) {
    setNote(result.ok ? null : { text: result.message, openOnly: false });
  }

  const frame = {
    backgroundColor: colors.raised,
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: pending ? colors.accent : colors.border,
    padding: 14,
    gap: 14,
    marginVertical: 6,
    alignSelf: 'stretch',
  } as const;
  const header = (title: string) => (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
      }}
    >
      <Icon sf="questionmark.bubble" size={15} color={pending ? colors.accent : colors.textFaint} />
      <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: '700', flexShrink: 1 }}>{title}</Text>
    </View>
  );
  const noteRow =
    note && (pending || !note.openOnly) ? <Text style={{ color: colors.danger, fontSize: 13 }}>{note.text}</Text> : null;

  // Malformed params (final review m3): never throw in render — that replaced the whole chat. The card
  // can't be answered as asked, so it offers only Skip: a response with no answers, the contract's
  // cancel-all. Never -32601/-32603, which would withdraw the request for every client.
  if (view === null) {
    return (
      <View accessibilityLabel="Hermes 有一个无法显示的问题" style={frame}>
        {header('Hermes 有一个问题')}
        <Text style={{ color: colors.textDim, fontSize: 14, lineHeight: 20 }}>{'此请求无法显示。'}</Text>
        {pending ? (
          <View style={{ flexDirection: 'row' }}>
            <CardButton label="跳过" a11y="跳过此请求" onPress={() => finish(responder.clarifySkipAll(card))} flex />
          </View>
        ) : (
          <SettledRow card={card} />
        )}
        {noteRow}
      </View>
    );
  }

  const first = view.questions[0];
  const singleAnswer = first ? draftAnswer(first, draftOf(first.qid)) : null;
  const title = view.batch ? `Hermes 有 ${view.questions.length}个问题` : 'Hermes 有一个问题';

  return (
    <View accessibilityLabel={title} style={frame}>
      {header(title)}
      {view.questions.map((q, i) => (
        <QuestionBlock
          key={q.qid}
          q={q}
          index={i}
          batch={view.batch}
          draft={draftOf(q.qid)}
          onChange={(d) => setDraft(q.qid, d)}
          locked={view.batch && q.qid in locked}
          lockedAnswer={locked[q.qid]}
          settled={!pending}
          disabled={!pending || busy}
          onSkip={() => void lock(q.qid, '')}
          onConfirm={(a) => void lock(q.qid, a)}
          onInputFocus={onInputFocus}
        />
      ))}
      {pending ? (
        view.batch ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <CardButton label="全部跳过" a11y="跳过所有问题" onPress={() => finish(responder.clarifySkipAll(card))} disabled={busy} flex />
            <CardButton label="全部提交" a11y="提交所有回答" onPress={() => void submitAll()} disabled={busy} primary flex />
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <CardButton label="跳过" a11y="跳过问题" onPress={() => finish(responder.clarifySingle(card, ''))} flex />
            <CardButton
              label="发送"
              a11y="发送回答"
              onPress={() => singleAnswer !== null && finish(responder.clarifySingle(card, singleAnswer))}
              disabled={singleAnswer === null}
              primary
              flex
            />
          </View>
        )
      ) : (
        <SettledRow card={card} />
      )}
      {noteRow}
    </View>
  );
}
