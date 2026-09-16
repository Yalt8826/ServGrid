/**
 * The owner's performance charts — NATIVE (OW.3, 2026-09-16).
 *
 * The console is a desk surface and the charts are a web build (the
 * Recharts import lives in `performanceChart.web.tsx`, which Metro
 * resolves for web alone). On the owner's phone the same numbers still
 * have to answer, so this renders the range's totals per person: no
 * axis, no library, no blank space where a chart would be.
 */
import { Text, View } from 'react-native';

import { DESK, SEMANTIC, SPACE, formatMoneyEnIN } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import type { PerfPerson, StackRow } from './performance';

export interface PerformanceChartProps {
  rows: StackRow[];
  people: PerfPerson[];
  kind: 'money' | 'count';
  height: number;
  testID?: string;
}

function totalFor(rows: readonly StackRow[], employeeId: string): number {
  return rows.reduce((sum, row) => sum + (row.values[employeeId] ?? 0), 0);
}

function label(value: number, kind: 'money' | 'count'): string {
  return kind === 'money' ? `₹${formatMoneyEnIN(value.toFixed(2))}` : String(value);
}

export function PerformanceChart({ rows, people, kind, testID }: PerformanceChartProps): React.ReactNode {
  const totals = people
    .map((person) => ({ person, total: totalFor(rows, person.id) }))
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total);

  return (
    <View testID={testID} style={{ gap: SPACE[2] }}>
      {totals.length === 0 ? (
        <Text style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary }}>Nothing in this range.</Text>
      ) : (
        totals.map((entry, index) => (
          <View
            key={entry.person.id}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE[3] }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2], flex: 1 }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  backgroundColor: DESK.chart.series[index % DESK.chart.series.length],
                }}
              />
              <Text numberOfLines={1} style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>
                {entry.person.name}
              </Text>
            </View>
            <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] }}>
              {label(entry.total, kind)}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}
