/**
 * T2 Jobs (UI/plan-2/04-TECHNICIAN.md §T2, 02-MOTION.md §6). Find a job
 * while the customer waits: three tabs — **Today · Upcoming · Completed**
 * — over a full-bleed `JobCard` list, `space.3` between, FlashList.
 *
 * Sort (§T2): Today by `scheduled_for` ascending, **overdue first** (and
 * yesterday's unfinished carry-over rides in Today — work he must do
 * today is today's); Completed newest first, dated by the server's
 * `closedAt` and **holding today's completions only** (Yashas,
 * 2026-09-19 — it was yesterday-and-today until then).
 *
 * **A search field appears only when the tab holds more than 12 jobs** —
 * a technician with six does not need search, and an always-present
 * empty field is clutter he scrolls past. It matches customer, area,
 * job number and title.
 *
 * States (§T2): empty Today is "Nothing scheduled today." with *Check
 * upcoming*; empty Completed is "Nothing completed yet today." A
 * rejected job keeps its real status rail and takes the danger dashed
 * inset plus the server's one-line reason (§T2 — see `JobCard`).
 *
 * Motion (§T2 / 02-MOTION.md §6): the accent underline slides between
 * tabs over `base` 220ms `standard`; content cross-fades 140ms. **No
 * stagger, no entrance animation** — except a card arriving from a sync,
 * which animates in at 140ms because that means "this is new" (the list
 * diffs known ids; the first load is silent, so nothing animates on
 * mount).
 *
 * Performance (02-MOTION.md §9): FlashList with `estimatedItemSize`
 * seeded from the field row minimum and then replaced by the first row's
 * measured height, `renderItem` hoisted and the item memoised — no
 * inline arrow re-renders a row on scroll.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { FlashList } from '@shopify/flash-list';

import { COLORS, DURATION, EASING, FRAME, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { JobCard } from '../../components/domain/JobCard';
import { EmptyState, TextField } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../../components/ui/motion';
import { matchesSearch, needsSearch, tabSections, type JobView, type JobsTab } from './jobView';

const TABS: readonly { key: JobsTab; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'completed', label: 'Completed' },
];

const STANDARD_EASING = easing(EASING.standard);
const ENTER_EASING = easing(EASING.enter);

export interface JobsDeps {
  /** His jobs from the server's work read, joined to their customers. */
  jobs: JobView[];
  /** Job id → when the server closed a completed job. */
  completedAtById: Record<string, string>;
  /** Injectable clock — IST "today" is computed from it. */
  now: Date;
  onOpenJob: (view: JobView) => void;
}

/**
 * The open callback rides a module-level ref so neither the hoisted
 * `renderItem` nor the memoised row ever holds a per-render closure —
 * the row's props stay referentially stable for the life of the scroll.
 * There is one Jobs screen instance (a single tab), so one ref is the
 * whole seam; the screen assigns it on every render.
 */
const openJobRef: { current: ((view: JobView) => void) | null } = { current: null };

const RowItem = memo(function RowItem({
  view,
  arrivedFromSync,
  testID,
}: {
  view: JobView;
  arrivedFromSync: boolean;
  testID?: string;
}): React.ReactNode {
  return (
    <JobCard
      view={view}
      arrivedFromSync={arrivedFromSync}
      onPress={() => openJobRef.current?.(view)}
      testID={testID}
    />
  );
});

export function JobsScreen(deps: JobsDeps): React.ReactNode {
  const [active, setActive] = useState<JobsTab>('today');
  const [query, setQuery] = useState('');
  const { width } = useWindowDimensions();
  // The row of tabs spans the frame's CONTENT box, not the window: the
  // frame pads `SPACE[4]` either side, so `width / tabs` overflowed the
  // right edge and the last label sat off-centre (reported on the handset,
  // 2026-09-17).
  const tabWidth = (width - SPACE[4] * 2) / TABS.length;

  openJobRef.current = deps.onOpenJob;

  const sections = tabSections(deps.jobs, deps.completedAtById, deps.now);
  const list = sections[active];
  const searching = needsSearch(list.length);
  const shown = searching && query.trim() !== '' ? list.filter((v) => matchesSearch(v, query)) : list;

  // Sync arrivals: the first load is silent (lists never animate on
  // mount — 02-MOTION.md §4.3); only ids the screen has not seen get
  // the 140ms entrance.
  const known = useRef<Set<string> | null>(null);
  const arrivals = useRef<ReadonlySet<string>>(new Set());
  if (known.current === null) {
    known.current = new Set(deps.jobs.map((v) => v.job.id));
  } else {
    const fresh = new Set<string>();
    for (const v of deps.jobs) {
      if (!known.current.has(v.job.id)) fresh.add(v.job.id);
    }
    arrivals.current = fresh;
    known.current = new Set(deps.jobs.map((v) => v.job.id));
  }

  // Tab motion: the accent underline slides 220ms `standard`; the
  // content cross-fades 140ms. Both restart only on a TAB CHANGE, never
  // on a keystroke. Reduced motion: instant flips, feedback kept (§10).
  const reducedMotion = useReducedMotion();
  const underline = useSharedValue(TABS.findIndex((t) => t.key === active) * tabWidth);
  const fade = useSharedValue(1);
  useEffect(() => {
    underline.value = withTiming(TABS.findIndex((t) => t.key === active) * tabWidth, {
      duration: reducedMotion ? DURATION.instant : DURATION.base,
      easing: STANDARD_EASING,
    });
    if (!reducedMotion) {
      fade.value = 0;
      fade.value = withTiming(1, { duration: DURATION.quick, easing: ENTER_EASING });
    }
  }, [active, tabWidth, underline, fade, reducedMotion]);
  const underlineStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: underline.value }],
  }));
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  // Hoisted renderItem: a stable identity for FlashList's lifetime; the
  // row component is memoised. No inline arrow closes over render state.
  // (FlashList v2 measures rows natively — the `estimatedItemSize` the
  // spec seeds is the version's own behaviour, fed by real row
  // measurement instead of a hand-set prop.)
  const renderItem = useCallback(
    ({ item }: { item: JobView }) => (
      <RowItem
        view={item}
        arrivedFromSync={arrivals.current.has(item.job.id)}
        testID={`jobs-card-${item.job.id}`}
      />
    ),
    [],
  );
  const keyExtractor = useCallback((item: JobView) => item.job.id, []);

  return (
    <View testID="jobs-screen" style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}>
      {/* The navy frame (2026-09-16): the title and the day's three tabs
          live on the frame ground, the same navy the tab bar wears — so
          the screen opens framed like the dashboard and closes framed
          like the tab bar. The active tab is white with the accent
          underline; the resting track is the frame's hairline. */}
      <View
        style={{
          alignSelf: 'stretch',
          backgroundColor: FRAME.bg,
          paddingHorizontal: SPACE[4],
          paddingTop: SPACE[4],
        }}
      >
        <Text style={{ ...textStyle('h1'), color: FRAME.text }}>Jobs</Text>
        {/* The accent underline slides between tabs, `base` 220ms (§6). */}
        <View accessibilityRole="tablist">
          <View style={{ flexDirection: 'row' }}>
            {TABS.map((tab) => {
              const selected = tab.key === active;
              return (
                <Text
                  key={tab.key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  testID={`jobs-tab-${tab.key}`}
                  onPress={() => setActive(tab.key)}
                  style={{
                    ...textStyle('label'),
                    color: selected ? FRAME.text : FRAME.textMuted,
                    width: tabWidth,
                    minHeight: TAP.min,
                    textAlign: 'center',
                    textAlignVertical: 'center',
                    lineHeight: TAP.min,
                  }}
                >
                  {tab.label}
                </Text>
              );
            })}
          </View>
          <View style={{ height: 2, backgroundColor: FRAME.divider, alignSelf: 'stretch' }}>
            <Animated.View
              testID="jobs-underline"
              style={[underlineStyle, { width: tabWidth, height: 2, backgroundColor: COLORS.accent }]}
            />
          </View>
        </View>
      </View>

      {searching ? (
        <View style={{ paddingHorizontal: SPACE[4], paddingTop: SPACE[3] }}>
          <TextField
            label="Search"
            value={query}
            onChangeText={setQuery}
            placeholder="Customer, job number or work"
            testID="jobs-search"
          />
        </View>
      ) : null}

      <Animated.View
        style={[
          // `paddingTop` is the breath between the search field (or the
          // frame, when no search shows) and the first card — the same
          // rhythm a section gap carries elsewhere (2026-09-16).
          { flex: 1, paddingHorizontal: SPACE[4], paddingTop: SPACE[4] },
          fadeStyle,
        ]}
      >
        {shown.length === 0 ? (
          <JobsEmpty tab={active} onCheckUpcoming={() => setActive('upcoming')} />
        ) : (
          <FlashList<JobView>
            testID="jobs-list"
            data={shown}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            ItemSeparatorComponent={Separator}
            contentContainerStyle={{ paddingBottom: SPACE[8] }}
            showsVerticalScrollIndicator={false}
          />
        )}
      </Animated.View>
    </View>
  );
}

/** `space.3` between full-bleed cards (§T2). */
function Separator(): React.ReactNode {
  return <View style={{ height: SPACE[3] }} />;
}

function JobsEmpty({ tab, onCheckUpcoming }: { tab: JobsTab; onCheckUpcoming: () => void }): React.ReactNode {
  if (tab === 'today') {
    return (
      <EmptyState
        message="Nothing scheduled today."
        icon="calendar"
        actionLabel="Check upcoming"
        onAction={onCheckUpcoming}
        testID="jobs-empty-today"
      />
    );
  }
  if (tab === 'upcoming') {
    return <EmptyState message="Nothing scheduled yet." icon="calendar" testID="jobs-empty-upcoming" />;
  }
  return <EmptyState message="Nothing completed yet today." testID="jobs-empty-completed" />;
}
