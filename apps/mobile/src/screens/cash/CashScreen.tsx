/**
 * The Cash tab (2026-09-18). One tab in the bar, two things under it: the
 * declaration he signs at the end of a shift, and the history of what he
 * declared and what the office made of it.
 *
 * Yashas, on where the history lives: "two tabs: Declare / History".
 * Before this the tab landed straight on the form — a declarations LIST
 * had existed and was removed on 2026-09-16 ("he declares — he does not
 * browse his past"), and when he asked for it back it came back as a
 * view of its own rather than a block under the form, so the daily act
 * stays exactly as quick as it was. **Declare is the default tab**, and
 * the form's screen still renders no list: `handover.test.tsx` holds that
 * invariant against the whole tree.
 *
 * The frame and the tabs sit OUTSIDE the ScrollView, the same shape the
 * service-call screen uses: the history is long enough to scroll, and
 * tabs that scroll out of reach are tabs you have to hunt for.
 *
 * The 7-day window is the technician's (Yashas: "the sales rep gets the
 * full history whereas the technician gets only the last 7 days
 * history"). The server enforces it on `/v1/cash/handovers/me`; the
 * client applies the same floor so the tab's caption and its contents
 * cannot disagree — see `withinHistoryWindow`.
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import type { CashAmendRequest, CashDeclareRequest, CashHandover } from '@servgrid/shared';
import { COLORS, FRAME, SPACE, SEMANTIC, TAP } from '@servgrid/shared';
import { haptic } from '../../components/ui/haptics';
import { textStyle } from '../../fonts/textStyle';
import { CashHistoryScreen } from './CashHistoryScreen';
import { HandoverPanel } from './HandoverPanel';
import { withinHistoryWindow } from './cashHistory';
import { handoverError } from './handoverModel';

type CashTab = 'declare' | 'history';

const TABS: readonly { key: CashTab; label: string }[] = [
  { key: 'declare', label: 'Declare' },
  { key: 'history', label: 'History' },
];

export interface CashScreenDeps {
  /** Today's IST business date, `YYYY-MM-DD` — computed once by the route. */
  today: string;
  /** His own declarations, newest-first order not required. */
  loadHistory: () => Promise<CashHandover[]>;
  declare: (input: CashDeclareRequest) => Promise<CashHandover>;
  /** `version` is the row's optimistic-concurrency version (`If-Match`). */
  amend: (id: string, version: number, input: CashAmendRequest) => Promise<CashHandover>;
  /**
   * The window his history is limited to, in days. `HANDOVER_WINDOW_DAYS`
   * for the technician; left out for the rep, who reads the whole record
   * (2026-09-18). Both roles declare on this one screen, so the role is
   * the route's business, not this screen's.
   */
  historyWindowDays?: number;
  /** Which tab opens. Declare by default — the daily act. */
  initialTab?: CashTab;
  testID?: string;
}

export function CashScreen(deps: CashScreenDeps): React.ReactNode {
  const [tab, setTab] = useState<CashTab>(deps.initialTab ?? 'declare');
  const [history, setHistory] = useState<CashHandover[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);

  const { width } = useWindowDimensions();
  // The frame's CONTENT box, not the window: the frame pads SPACE[4] a
  // side, and a tab row sized off the window overflows by exactly that.
  const tabWidth = (width - SPACE[4] * 2) / TABS.length;

  useEffect(() => {
    let alive = true;
    setHistoryError(null);
    deps
      .loadHistory()
      .then((rows) => {
        if (alive) setHistory(rows);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        // An empty list here would be a claim that he never declared; the
        // banner says the read failed instead.
        setHistory([]);
        setHistoryError(handoverError(error));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads]);

  /** Fold a declare or an amend in without a second read. */
  function fold(row: CashHandover): void {
    setHistory((current) => [row, ...(current ?? []).filter((h) => h.id !== row.id)]);
  }

  const windowDays = deps.historyWindowDays;
  const windowed = withinHistoryWindow(history ?? [], deps.today, windowDays);
  const caption =
    tab === 'declare'
      ? 'Declare the cash you are handing over. One number.'
      : windowDays === undefined
        ? 'Every declaration, and what the office made of it.'
        : `The last ${windowDays} days, and what the office made of them.`;

  return (
    <View style={styles.screen} testID={deps.testID ?? 'cash-screen'}>
      <View style={styles.frame}>
        <Text style={styles.frameTitle} testID="handover-title">
          Cash handover
        </Text>
        <Text style={styles.frameCaption} testID="cash-caption">
          {caption}
        </Text>
        <View accessibilityRole="tablist" style={styles.tabs}>
          <View style={styles.tabRow}>
            {TABS.map((entry) => {
              const selected = entry.key === tab;
              const count = entry.key === 'history' && history !== null ? windowed.length : null;
              return (
                <Text
                  key={entry.key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  testID={`cash-tab-${entry.key}`}
                  onPress={() => {
                    haptic('pickerSelect');
                    setTab(entry.key);
                  }}
                  style={[styles.tab, { width: tabWidth }, selected ? styles.tabOn : null]}
                >
                  {count === null ? entry.label : `${entry.label} · ${count}`}
                </Text>
              );
            })}
          </View>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID="handover-screen"
      >
        {tab === 'declare' ? (
          <HandoverPanel
            today={deps.today}
            history={history}
            declare={deps.declare}
            amend={deps.amend}
            onChanged={fold}
          />
        ) : (
          <CashHistoryScreen
            rows={history}
            today={deps.today}
            windowDays={windowDays}
            error={historyError}
            onRetry={() => setLoads((n) => n + 1)}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app, alignSelf: 'stretch' },
  /** The navy frame: the route paints the same slate behind the status bar. */
  frame: {
    alignSelf: 'stretch',
    backgroundColor: FRAME.bg,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[4],
    paddingBottom: SPACE[2],
  },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  /** The two views as tabs on the frame — the service-call screen's control. */
  tabs: { alignSelf: 'stretch', marginTop: SPACE[2] },
  tabRow: { flexDirection: 'row' },
  tab: {
    ...textStyle('label'),
    color: FRAME.textMuted,
    minHeight: TAP.min,
    textAlign: 'center',
    textAlignVertical: 'center',
    lineHeight: TAP.min,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabOn: { color: FRAME.text, borderBottomColor: COLORS.accent },
  scroll: { flex: 1 },
  content: { paddingHorizontal: SPACE[4], paddingTop: SPACE[2], paddingBottom: SPACE[8] },
});
