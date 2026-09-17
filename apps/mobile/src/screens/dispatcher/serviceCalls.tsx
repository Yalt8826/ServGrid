/**
 * Service calls (2026-09-17, Yashas) — the UPS/battery six-month cycle.
 *
 * "Once a job is completed for a customer the dispatcher is reminded of
 * that customer 6 months later that its due for his service" — so this
 * page is one question: **who do I ring today**. A customer appears when
 * their last completed job is six months old and nobody is already going
 * to the site; the dispatcher either books the visit or pushes the
 * reminder three months out with what the customer said.
 *
 * Two lists, because a promise is work too: DUE NOW (overdue first) and
 * PUSHED BACK (when the calls he deferred come round again). Both are
 * derived server-side in `v_service_calls` — no phone clock decides
 * whether a customer is due, which is the same rule the AMC reminders
 * follow.
 *
 * The row is the phone call: *Call* dials, *Assign* opens the dispatch
 * form with the customer already chosen (the AMC tab's own deep link),
 * and "Not now" files what was said and when to ring again.
 */
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  alpha,
  COLORS,
  FRAME,
  ICON,
  RADII,
  SEMANTIC,
  SERVICE_CALL_OUTCOME_LABELS,
  SERVICE_CALL_OUTCOMES,
  SERVICE_CALL_SNOOZE_MONTHS,
  SPACE,
  TAP,
  TINT,
  type FollowUpBody,
  type ServiceCall,
  type ServiceCallOutcome,
} from '@servgrid/shared';
import { Banner, Button, CalendarGrid, EmptyState, SectionHeader, Sheet, Skeleton, TextField, useDensity } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
import { haptic } from '../../components/ui/haptics';
import { useSkeleton } from '../../components/ui/Skeleton';
import { textStyle } from '../../fonts/textStyle';

export const SERVICE_CALLS_OFFLINE_MESSAGE = 'No connection. The call list is not live.';

export interface ServiceCallsScreenProps {
  offline: boolean;
  loading: boolean;
  error: string | null;
  /** Who is due a call — overdue first, as the server orders them. */
  due: ServiceCall[] | null;
  /** Who was pushed back, and when they return. */
  pushed: ServiceCall[] | null;
  saving: boolean;
  saveError: string | null;
  onRetry(): void;
  onRecord(customerId: string, body: FollowUpBody): Promise<void>;
  onDismissError(): void;
  /** Opens the dispatch form with this customer already chosen. */
  onAssign(customerId: string): void;
  /** Injectable clock, so the tests and the sheet agree about today. */
  todayIso: string;
  testID?: string;
}

/** `3 Mar 2026` — the app's own date form, from a plain `YYYY-MM-DD` day. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayLabel(iso: string): string {
  const [y = '', m = '', d = ''] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** `today` | `3 days overdue` | `in 12 days` — a reminder's age, in words. */
export function dueWords(daysDue: number): string {
  if (daysDue === 0) return 'due today';
  if (daysDue > 0) return `${daysDue} ${daysDue === 1 ? 'day' : 'days'} overdue`;
  const ahead = Math.abs(daysDue);
  return `in ${ahead} ${ahead === 1 ? 'day' : 'days'}`;
}

/** `+3 months`, the day the sheet proposes and the only maths in the file. */
export function snoozeDay(todayIso: string, months = SERVICE_CALL_SNOOZE_MONTHS): string {
  const [y = '1970', m = '1', d = '1'] = todayIso.split('-');
  const base = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const month = base.getUTCMonth() + months;
  const year = base.getUTCFullYear() + Math.floor(month / 12);
  const day = Math.min(Number(d), new Date(Date.UTC(year, ((month % 12) + 12) % 12 + 1, 0)).getUTCDate());
  const mm = String(((month % 12) + 12) % 12 + 1).padStart(2, '0');
  return `${year}-${mm}-${String(day).padStart(2, '0')}`;
}

// ── one customer's row ───────────────────────────────────────────────────

function ServiceCallRow({
  call,
  pushed,
  disabled,
  onCall,
  onAssign,
  onPush,
  testID,
}: {
  call: ServiceCall;
  /** True in the pushed-back list: the row reads as a promise, not a debt. */
  pushed: boolean;
  disabled: boolean;
  onCall(): void;
  onAssign(): void;
  onPush(): void;
  testID: string;
}): React.ReactNode {
  const density = useDensity();
  const body = textStyle('body', density);
  const bodyStrong = textStyle('bodyStrong', density);
  // The rail's colour is the row's urgency: overdue burns, a promise does not.
  const rail = pushed ? SEMANTIC.text.secondary : call.daysDue > 0 ? SEMANTIC.feedback.danger : COLORS.accent;

  return (
    <View style={styles.card} testID={testID}>
      <View style={[styles.rail, { backgroundColor: rail }]} />
      <View style={styles.cardBody}>
        <View style={styles.identity}>
          <Text numberOfLines={1} style={[styles.name, bodyStrong]}>
            {call.customerName}
          </Text>
          {/* Phone and area on one line — the two things he reads out loud. */}
          <Text numberOfLines={1} style={[styles.meta, body]}>
            {call.phone}
            {call.area === null ? '' : ` · ${call.area}`}
          </Text>
        </View>
        <View style={styles.facts}>
          <Text numberOfLines={2} style={styles.fact}>
            {`Last service ${dayLabel(call.lastServiceOn)}`}
            {call.lastJobNumber === null ? '' : ` · ${call.lastJobNumber}`}
          </Text>
          <View style={pushed ? styles.chipQuiet : call.daysDue > 0 ? styles.chipLate : styles.chipDue}>
            <Text style={styles.chipWord}>
              {pushed ? `Back ${dayLabel(call.remindOn)}` : dueWords(call.daysDue)}
            </Text>
          </View>
          {call.lastNote === null ? null : (
            <Text numberOfLines={2} style={styles.note}>
              {call.lastCalledBy === null ? call.lastNote : `${call.lastNote} — ${call.lastCalledBy}`}
            </Text>
          )}
        </View>
        <View style={styles.actions}>
          <Button label="Call" icon="phone" variant="secondary" disabled={disabled} onPress={onCall} testID={`${testID}-call`} />
          <Button
            label="Assign"
            icon="send"
            variant="primary"
            disabled={disabled}
            onPress={onAssign}
            testID={`${testID}-assign`}
          />
          <Button
            label="Not now"
            icon="clock"
            variant="ghost"
            disabled={disabled}
            onPress={onPush}
            testID={`${testID}-push`}
          />
        </View>
      </View>
    </View>
  );
}

// ── the screen ───────────────────────────────────────────────────────────

export function ServiceCallsScreen(props: ServiceCallsScreenProps): React.ReactNode {
  const [pushing, setPushing] = useState<ServiceCall | null>(null);
  const loading = props.loading || (props.due === null && props.error === null);
  const showSkeleton = useSkeleton(loading);
  const due = props.due ?? [];
  const pushed = props.pushed ?? [];

  return (
    <View style={styles.screen} testID={props.testID ?? 'service-calls'}>
      <View style={styles.frame}>
        <Text style={styles.frameTitle} testID="service-calls-title">
          Service calls
        </Text>
        <Text style={styles.frameCaption}>Ups and batteries every six months — ring them when the six are up.</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {props.offline ? (
          <Banner tone="danger" message={SERVICE_CALLS_OFFLINE_MESSAGE} testID="service-calls-offline" />
        ) : null}
        {props.saveError !== null ? (
          <Banner tone="danger" message={props.saveError} onDismiss={props.onDismissError} testID="service-calls-error" />
        ) : null}
        {props.error !== null ? (
          <Banner
            tone="danger"
            message={props.error}
            actions={[{ label: 'Retry', onPress: props.onRetry }]}
            testID="service-calls-read-error"
          />
        ) : null}

        <View style={styles.sectionFirst} testID="service-calls-due-section">
          <SectionHeader label="Due now" icon="phone" tint={COLORS.accent} count={props.due === null ? undefined : due.length} />
          {props.due === null ? (
            showSkeleton ? <SectionSkeleton testID="service-calls-skeleton" /> : null
          ) : due.length === 0 ? (
            <EmptyState
              message="Nobody is due a service call."
              testID="service-calls-empty"
            />
          ) : (
            due.map((call) => (
              <ServiceCallRow
                key={call.customerId}
                call={call}
                pushed={false}
                disabled={props.saving}
                onCall={() => void Linking.openURL(`tel:${call.phone}`)}
                onAssign={() => props.onAssign(call.customerId)}
                onPush={() => setPushing(call)}
                testID={`service-call-${call.customerId}`}
              />
            ))
          )}
        </View>

        <View style={styles.section} testID="service-calls-pushed-section">
          <SectionHeader label="Pushed back" icon="clock" count={props.pushed === null ? undefined : pushed.length} />
          {props.pushed === null ? (
            showSkeleton ? <SectionSkeleton testID="service-calls-pushed-skeleton" /> : null
          ) : pushed.length === 0 ? (
            <EmptyState message="Nobody has asked to be rung later." testID="service-calls-pushed-empty" />
          ) : (
            pushed.map((call) => (
              <ServiceCallRow
                key={call.customerId}
                call={call}
                pushed
                disabled={props.saving}
                onCall={() => void Linking.openURL(`tel:${call.phone}`)}
                onAssign={() => props.onAssign(call.customerId)}
                onPush={() => setPushing(call)}
                testID={`service-call-pushed-${call.customerId}`}
              />
            ))
          )}
        </View>
      </ScrollView>

      {pushing === null ? null : (
        <PushBackSheet
          call={pushing}
          todayIso={props.todayIso}
          saving={props.saving}
          error={props.saveError}
          onDismiss={() => {
            props.onDismissError();
            setPushing(null);
          }}
          onConfirm={async (body) => {
            await props.onRecord(pushing.customerId, body);
            setPushing(null);
          }}
        />
      )}
    </View>
  );
}

// ── "not now, try in three months" ───────────────────────────────────────

function PushBackSheet({
  call,
  todayIso,
  saving,
  error,
  onDismiss,
  onConfirm,
}: {
  call: ServiceCall;
  todayIso: string;
  saving: boolean;
  error: string | null;
  onDismiss(): void;
  onConfirm(body: FollowUpBody): Promise<void>;
}): React.ReactNode {
  const [outcome, setOutcome] = useState<ServiceCallOutcome>('called');
  const [note, setNote] = useState('');
  const [nextCallOn, setNextCallOn] = useState<string | null>(snoozeDay(todayIso));
  const [picking, setPicking] = useState(false);

  // Three months out is the offer, not a rule: the date can be moved, and
  // cleared entirely when the customer is simply not interested.
  const ready = nextCallOn !== null || note.trim() !== '';

  return (
    <Sheet
      visible
      title={`Not now — ${call.customerName}`}
      hasUnsavedInput={note.trim() !== ''}
      onDismiss={onDismiss}
      testID="service-call-push-sheet"
      actions={
        <Button
          label="Save the call"
          icon="check"
          fullwidth
          loading={saving}
          disabled={!ready}
          disabledReason={ready ? undefined : 'Pick a date to call again, or say what happened.'}
          onPress={() => void onConfirm({ outcome, ...(note.trim() === '' ? {} : { note: note.trim() }), nextCallOn })}
          testID="service-call-push-save"
        />
      }
    >
      <SectionHeader label="What happened" icon="phone" tint={COLORS.accent} />
      <View style={styles.outcomes}>
        {SERVICE_CALL_OUTCOMES.map((value) => {
          const selected = outcome === value;
          return (
            <Pressable
              key={value}
              testID={`service-call-outcome-${value}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => {
                haptic('pickerSelect');
                setOutcome(value);
                // "Not interested" is an ending, not a postponement: the
                // date comes off so the reminder stops asking.
                if (value === 'not_interested') setNextCallOn(null);
              }}
              style={[styles.outcomeRow, selected ? styles.outcomeRowSelected : null]}
            >
              <Text style={[styles.outcomeWord, selected ? styles.outcomeWordSelected : null]}>
                {SERVICE_CALL_OUTCOME_LABELS[value]}
              </Text>
              {selected ? <Icon name="check" size={ICON.sm} color={FRAME.text} /> : null}
            </Pressable>
          );
        })}
      </View>

      <SectionHeader label="Call again" icon="calendar" />
      <View style={styles.dayRow}>
        <Text style={styles.dayValue} testID="service-call-push-day">
          {nextCallOn === null ? 'No date — the cycle closes' : dayLabel(nextCallOn)}
        </Text>
        <Button
          label={nextCallOn === null ? 'Pick a day' : 'Change'}
          icon="calendar"
          variant="secondary"
          onPress={() => setPicking(!picking)}
          testID="service-call-push-day-toggle"
        />
      </View>
      {picking ? (
        <CalendarGrid
          value={nextCallOn}
          todayIso={todayIso}
          onSelect={(iso) => {
            haptic('pickerSelect');
            setNextCallOn(iso);
          }}
          testID="service-call-push-calendar"
        />
      ) : null}

      <SectionHeader label="Note" icon="document" />
      <TextField
        label="What did they say?"
        value={note}
        onChangeText={setNote}
        multiline
        rows={2}
        placeholder="Optional — but it is what the next dispatcher reads"
        testID="service-call-push-note"
      />
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
    </Sheet>
  );
}

const SKELETON_ROW_COUNT = 3;

/** Three placeholder rows, the geometry of a real card. */
function SectionSkeleton({ testID }: { testID: string }): React.ReactNode {
  return (
    <View style={styles.skeletonWrap} testID={testID}>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
        <View key={i} style={styles.card}>
          <View style={[styles.rail, { backgroundColor: SEMANTIC.bg.dense }]} />
          <View style={styles.skeletonBody}>
            <Skeleton width="52%" height={16} />
            <Skeleton width="34%" height={13} />
            <Skeleton width="72%" height={13} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  frame: {
    backgroundColor: FRAME.bg,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[3],
    paddingBottom: SPACE[3],
    gap: 2,
  },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  content: { paddingHorizontal: SPACE[4], paddingBottom: SPACE[8], paddingTop: SPACE[2] },
  section: { marginTop: SPACE[5] },
  sectionFirst: { marginTop: SPACE[3] },
  /** One customer, one card: the rail carries how late the call is. */
  card: {
    flexDirection: 'row',
    marginTop: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  rail: { width: 4 },
  cardBody: { flex: 1, padding: SPACE[3], gap: SPACE[2] },
  identity: { gap: 2 },
  name: { color: SEMANTIC.text.primary },
  meta: { color: SEMANTIC.text.secondary },
  facts: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE[2] },
  fact: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  chipQuiet: {
    paddingHorizontal: SPACE[2],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.app,
  },
  chipDue: {
    paddingHorizontal: SPACE[2],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: alpha(COLORS.accent, TINT.chipLine),
    backgroundColor: alpha(COLORS.accent, TINT.chip),
  },
  chipLate: {
    paddingHorizontal: SPACE[2],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: alpha(SEMANTIC.feedback.danger, TINT.chipLine),
    backgroundColor: alpha(SEMANTIC.feedback.danger, TINT.chip),
  },
  chipWord: { ...textStyle('caption'), color: SEMANTIC.text.primary },
  note: { ...textStyle('caption'), color: SEMANTIC.text.secondary, flexBasis: '100%' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] },
  outcomes: { alignSelf: 'stretch', gap: SPACE[1], marginTop: SPACE[3] },
  outcomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE[2],
    minHeight: TAP.console,
    paddingHorizontal: SPACE[3],
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  outcomeRowSelected: { backgroundColor: SEMANTIC.bg.dark },
  outcomeWord: { ...textStyle('body'), color: SEMANTIC.text.primary },
  outcomeWordSelected: { ...textStyle('bodyStrong'), color: SEMANTIC.text.onDark },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE[3],
    marginTop: SPACE[3],
  },
  dayValue: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  error: { ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: SPACE[2] },
  skeletonWrap: { gap: 0 },
  skeletonBody: { flex: 1, padding: SPACE[3], gap: SPACE[2] },
});
