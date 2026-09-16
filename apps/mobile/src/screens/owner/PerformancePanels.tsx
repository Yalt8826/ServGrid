/**
 * The owner's four performance charts (OW.3, 2026-09-16) — the set he
 * asked for, in the order he asked for it:
 *
 *   1. revenue collected per technician, through the range
 *   2. jobs done per technician
 *   3. sales value per rep
 *   4. number of sales per rep
 *
 * One toolbar drives all four: the range (this week, 30 days, 90 days)
 * and two filters — a technician and a rep. With nobody chosen the bars
 * stack one segment per person, so the day's total and its split read at
 * once; choosing a person leaves theirs alone on the same axis, which is
 * what makes the two readings comparable.
 *
 * This section owns its read (`useOwnerPerformance`) so the pure
 * dashboard screen keeps its props; the route passes it in as a slot.
 */
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { DESK, SEMANTIC, SPACE, formatMoneyEnIN } from '@servgrid/shared';
import { Banner, Panel, PanelRow, Select, Skeleton, useDensity } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { PerformanceChart } from './performanceChart';
import {
  PERFORMANCE_RANGES,
  RANGE_LABELS,
  countPoints,
  isEmptySeries,
  moneyPoints,
  personOptions,
  rangeTotal,
  seriesPeople,
  stackRows,
  type PerformanceRange,
} from './performance';
import { useOwnerPerformance } from './useOwnerData';

const CHART_HEIGHT_DESK = 260;
const CHART_HEIGHT_PHONE = 0; // the phone renders totals, not an axis

function RangeSwitch({
  range,
  onChange,
}: {
  range: PerformanceRange;
  onChange: (next: PerformanceRange) => void;
}): React.ReactNode {
  return (
    <View style={{ flexDirection: 'row', gap: 0 }} testID="owner-perf-range">
      {PERFORMANCE_RANGES.map((key, index) => {
        const selected = key === range;
        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            testID={`owner-perf-range-${key}`}
            onPress={() => onChange(key)}
            style={{
              paddingHorizontal: SPACE[3],
              paddingVertical: SPACE[2],
              borderWidth: 1,
              borderColor: selected ? SEMANTIC.line.focus : SEMANTIC.line.default,
              backgroundColor: selected ? SEMANTIC.bg.dark : SEMANTIC.bg.raised,
              borderTopLeftRadius: index === 0 ? 4 : 0,
              borderBottomLeftRadius: index === 0 ? 4 : 0,
              borderTopRightRadius: index === PERFORMANCE_RANGES.length - 1 ? 4 : 0,
              borderBottomRightRadius: index === PERFORMANCE_RANGES.length - 1 ? 4 : 0,
              marginLeft: index === 0 ? 0 : -1,
            }}
          >
            <Text
              style={{
                ...textStyle('label'),
                color: selected ? SEMANTIC.text.onDark : SEMANTIC.text.secondary,
              }}
            >
              {RANGE_LABELS[key]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The figure above each chart: what the range came to, for whoever is selected. */
function ChartTotal({ value, kind }: { value: number; kind: 'money' | 'count' }): React.ReactNode {
  return (
    <Text
      style={{ ...textStyle('h2'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] }}
      testID="owner-perf-total"
    >
      {kind === 'money' ? `₹${formatMoneyEnIN(value.toFixed(2))}` : String(value)}
    </Text>
  );
}

export function PerformancePanels(): React.ReactNode {
  const desk = useDensity() === 'desk';
  const [range, setRange] = useState<PerformanceRange>('week');
  const [technicianId, setTechnicianId] = useState<string>('');
  const [repId, setRepId] = useState<string>('');
  const performance = useOwnerPerformance(range);

  const wire = performance.data;

  const series = useMemo(() => {
    if (wire === null) return null;
    const tech = technicianId === '' ? null : technicianId;
    const rep = repId === '' ? null : repId;
    return {
      revenue: stackRows(wire.days, moneyPoints(wire.technicianRevenue), wire.technicians, tech, range),
      jobs: stackRows(wire.days, countPoints(wire.technicianJobs), wire.technicians, tech, range),
      salesValue: stackRows(wire.days, moneyPoints(wire.repSalesValue), wire.reps, rep, range),
      salesCount: stackRows(wire.days, countPoints(wire.repSalesCount), wire.reps, rep, range),
      technicians: seriesPeople(wire.technicians, tech),
      reps: seriesPeople(wire.reps, rep),
    };
  }, [wire, technicianId, repId, range]);

  const height = desk ? CHART_HEIGHT_DESK : CHART_HEIGHT_PHONE;

  function chartPanel(
    title: string,
    rows: ReturnType<typeof stackRows>,
    people: { id: string; name: string }[],
    kind: 'money' | 'count',
    testID: string,
  ): React.ReactNode {
    return (
      <View style={desk ? { flex: 1 } : undefined}>
        <Panel title={title} testID={testID}>
          <ChartTotal value={rangeTotal(rows)} kind={kind} />
          {isEmptySeries(rows) ? (
            <Text
              testID={`${testID}-empty`}
              style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary, marginTop: SPACE[3] }}
            >
              Nothing in this range.
            </Text>
          ) : (
            <View style={{ marginTop: SPACE[3] }}>
              <PerformanceChart
                rows={rows}
                people={people}
                kind={kind}
                height={height}
                testID={`${testID}-chart`}
              />
            </View>
          )}
        </Panel>
      </View>
    );
  }

  return (
    // The section outranks what the page paints after it, and the toolbar
    // outranks the panels under it (OW.6). Both are needed: a z-index only
    // competes inside its own stacking context, so raising the open field
    // alone left its menu behind the charts below — the same bug the Jobs
    // filter bar had, one level up.
    <View style={{ gap: desk ? DESK.page.gap : SPACE[4], zIndex: 20 }} testID="owner-performance">
      <View
        style={{
          flexDirection: desk ? 'row' : 'column',
          alignItems: desk ? 'flex-end' : 'stretch',
          justifyContent: 'space-between',
          gap: SPACE[3],
          zIndex: 30,
        }}
      >
        <View style={{ gap: 2 }}>
          <Text style={{ ...textStyle('h2'), color: SEMANTIC.text.primary }}>Performance</Text>
          {wire === null ? null : (
            <Text style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary }} testID="owner-perf-range-label">
              {`${wire.range.from} to ${wire.range.to}`}
            </Text>
          )}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: SPACE[3], flexWrap: 'wrap' }}>
          <RangeSwitch range={range} onChange={setRange} />
          <View style={{ minWidth: 190 }}>
            <Select
              label="Technician"
              value={technicianId}
              options={personOptions(wire?.technicians ?? [], 'All technicians')}
              onSelect={setTechnicianId}
              testID="owner-perf-technician"
            />
          </View>
          <View style={{ minWidth: 190 }}>
            <Select
              label="Sales rep"
              value={repId}
              options={personOptions(wire?.reps ?? [], 'All reps')}
              onSelect={setRepId}
              testID="owner-perf-rep"
            />
          </View>
        </View>
      </View>

      {performance.error !== null ? (
        <Banner tone="danger" message={performance.error} onDismiss={performance.reload} testID="owner-perf-error" />
      ) : series === null ? (
        <PanelRow>
          <View style={desk ? { flex: 1 } : undefined}>
            <Skeleton width="100%" height={desk ? 320 : 120} radius={8} testID="owner-perf-skeleton" />
          </View>
          <View style={desk ? { flex: 1 } : undefined}>
            <Skeleton width="100%" height={desk ? 320 : 120} radius={8} testID="owner-perf-skeleton" />
          </View>
        </PanelRow>
      ) : (
        <>
          <PanelRow>
            {chartPanel('Revenue collected by technician', series.revenue, series.technicians, 'money', 'owner-perf-revenue')}
            {chartPanel('Jobs done by technician', series.jobs, series.technicians, 'count', 'owner-perf-jobs')}
          </PanelRow>
          <PanelRow>
            {chartPanel('Sales by rep', series.salesValue, series.reps, 'money', 'owner-perf-sales-value')}
            {chartPanel('Number of sales by rep', series.salesCount, series.reps, 'count', 'owner-perf-sales-count')}
          </PanelRow>
        </>
      )}
    </View>
  );
}
