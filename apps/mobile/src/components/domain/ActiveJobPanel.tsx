/**
 * `ActiveJobPanel` — the job he is on, raised above the lists (mobile UI
 * overhaul, 2026-09-16; Yashas: "once he selects a job and starts it in
 * the dashboard it needs to highlight the current active job with a
 * button to call the customer and a button to navigate and the details
 * of the job").
 *
 * A technician works one job at a time, so the dashboard has exactly one
 * job that is *current* — and while it stands, no other job on the screen
 * offers a start. That makes this panel the screen's one actionable card,
 * and the reason it is a different object from `JobCard` rather than a
 * variant of it: a job card is a row in a list of many, this is the
 * answer to "what am I doing right now".
 *
 * What it shows, and why each line is here:
 *
 * - **Who and where** (`customer · area`) — the two things he says out
 *   loud when he arrives.
 * - **What the work is** (`title`) and **what the customer said**
 *   (`description`): the call happens before the visit, so the words have
 *   to be on the same screen as the Call button.
 * - **When** — the day as well as the clock when the job is not today.
 *   An active job is usually today's, but "active" is a status, not a
 *   date: a job carried over from yesterday is still the one he is on.
 * - **Who to ask for** (`contactName`) beside the number that rings it.
 * - *Call* and *Navigate*, side by side: the two things he does on the
 *   way, both `secondary` so they never compete with the one primary.
 * - **The one primary** — the job's next status write (*Arrive*, later
 *   *Complete job*). It is the only accent-filled control on the
 *   dashboard, which is what the accent is for.
 *
 * The rejected/pending treatment is the card's, unchanged and for the
 * same reasons (see `JobCard`): the rail keeps the real status and a
 * refused write takes the danger inset beside it, never a repainted rail.
 */
import { Pressable, Text, View } from 'react-native';

import { alpha, COLORS, ICON, RADII, SEMANTIC, SPACE, STALE, TINT } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { Button } from '../ui';
import { Icon } from '../ui/icons';
import { StatusPill } from './StatusPill';
import { contractChipLabel } from './JobCard';
import { istTimeLabel, railColorOf, type JobView } from '../../screens/technician/jobView';

const RAIL_WIDTH = 4;
const HAIRLINE = 1;

export interface ActiveJobPanelProps {
  view: JobView;
  /** The job's day when it is not today (`dayLabelOf`); null for today. */
  dayLabel?: string | null;
  /** Opens the full detail screen — the panel shows the headline, not everything. */
  onPress: () => void;
  onCall: () => void;
  onNavigate: () => void;
  /**
   * The job's next status write, or null when there is none to offer
   * (*Complete job* is the caller's to build: completion is a sheet, not
   * a status write from here).
   */
  primary?: { label: string; onPress: () => void } | null;
  testID?: string;
}

export function ActiveJobPanel({
  view,
  dayLabel = null,
  onPress,
  onCall,
  onNavigate,
  primary = null,
  testID,
}: ActiveJobPanelProps): React.ReactNode {
  const { job } = view;
  const rejected = view.rejectedMessage !== null;
  const contract = contractChipLabel(job.contract);
  const hasPhone = job.contactPhone !== null;

  return (
    <View
      testID={testID}
      style={{
        alignSelf: 'stretch',
        flexDirection: 'row',
        borderRadius: RADII.none,
        borderWidth: 1,
        borderColor: SEMANTIC.line.default,
        backgroundColor: SEMANTIC.bg.raised,
      }}
    >
      {/* The rail, as on every docket: the card's real status. */}
      <View testID={testID ? `${testID}-rail` : undefined} style={{ width: RAIL_WIDTH, backgroundColor: railColorOf(job.status) }} />
      {view.pending || rejected ? (
        <View
          testID={testID ? `${testID}-inset` : undefined}
          style={{
            width: STALE.insetWidth,
            borderLeftWidth: STALE.insetWidth,
            borderLeftColor: rejected ? SEMANTIC.feedback.danger : STALE.insetColor,
            borderStyle: 'dashed',
            backgroundColor: SEMANTIC.bg.raised,
          }}
        />
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Active job: ${view.customerName}, ${job.title}`}
        onPress={onPress}
        style={({ pressed }) => ({ flex: 1, backgroundColor: pressed ? SEMANTIC.bg.pressed : 'transparent' })}
      >
        {/* The band: this is not a row in a list, and it says so. */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: SPACE[2],
            paddingHorizontal: SPACE[3],
            paddingVertical: SPACE[2],
            backgroundColor: alpha(COLORS.accent, TINT.band),
            borderBottomWidth: HAIRLINE,
            borderBottomColor: SEMANTIC.line.default,
          }}
        >
          <Icon name="wrench" size={ICON.sm} color={SEMANTIC.text.primary} />
          <Text style={{ ...textStyle('label'), color: SEMANTIC.text.primary, letterSpacing: 0.8, flex: 1 }}>
            ACTIVE JOB
          </Text>
          <StatusPill status={job.status} testID={testID ? `${testID}-status` : undefined} />
        </View>

        <View style={{ padding: SPACE[3], gap: SPACE[2] }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[2] }}>
            <Text style={{ ...textStyle('h2'), color: SEMANTIC.text.primary, flex: 1 }}>
              {view.area === '' ? view.customerName : `${view.customerName} · ${view.area}`}
            </Text>
            <View
              style={{
                borderRadius: RADII.control,
                backgroundColor: alpha(SEMANTIC.text.primary, TINT.band),
                paddingHorizontal: 6,
                paddingVertical: 2,
              }}
            >
              <Text testID={testID ? `${testID}-number` : undefined} style={{ ...textStyle('mono'), color: SEMANTIC.text.secondary }}>
                {job.jobNumber}
              </Text>
            </View>
          </View>

          <Text style={{ ...textStyle('body'), color: SEMANTIC.text.secondary }}>{job.title}</Text>

          <View style={{ height: HAIRLINE, backgroundColor: SEMANTIC.line.default }} />

          {/* When. The day only when it is not today — see the docblock. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2] }}>
            <Icon name="clock" size={ICON.sm} color={SEMANTIC.text.placeholder} />
            {dayLabel === null ? null : (
              <Text style={{ ...textStyle('label'), color: SEMANTIC.text.secondary }}>{dayLabel}</Text>
            )}
            <Text
              testID={testID ? `${testID}-time` : undefined}
              style={{ ...textStyle('mono'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] }}
            >
              {job.scheduledFor === null ? 'No time' : istTimeLabel(job.scheduledFor)}
            </Text>
            {contract === null ? null : (
              <Text
                style={{
                  ...textStyle('label'),
                  color: SEMANTIC.text.secondary,
                  borderWidth: 1,
                  borderColor: SEMANTIC.line.default,
                  borderRadius: RADII.control,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                }}
              >
                {contract}
              </Text>
            )}
          </View>

          {/* What the customer said — read on the way, next to Call. */}
          {job.description === null ? null : (
            <Text style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary }} numberOfLines={3}>
              {job.description}
            </Text>
          )}

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2] }}>
            <Icon name="profile" size={ICON.sm} color={SEMANTIC.text.placeholder} />
            <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>
              {job.contactName ?? 'No contact named'}
            </Text>
          </View>
        </View>

        {rejected ? (
          <Text
            style={{
              ...textStyle('caption'),
              color: SEMANTIC.feedback.danger,
              paddingHorizontal: SPACE[3],
              paddingBottom: SPACE[2],
            }}
            numberOfLines={2}
            testID={testID ? `${testID}-rejected` : undefined}
          >
            {view.rejectedMessage}
          </Text>
        ) : null}

        {/* The two things he does on the way, then the one primary. */}
        <View style={{ height: HAIRLINE, backgroundColor: SEMANTIC.line.default }} />
        <View style={{ padding: SPACE[3], gap: SPACE[3] }}>
          <View style={{ flexDirection: 'row', gap: SPACE[3] }}>
            <View style={{ flex: 1 }}>
              <Button
                label="Call"
                icon="phone"
                variant="secondary"
                fullwidth
                disabled={!hasPhone}
                disabledReason={hasPhone ? undefined : 'No number on this job.'}
                onPress={onCall}
                testID={testID ? `${testID}-call` : undefined}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label="Navigate"
                icon="navigate"
                variant="secondary"
                fullwidth
                onPress={onNavigate}
                testID={testID ? `${testID}-navigate` : undefined}
              />
            </View>
          </View>
          {primary === null ? null : (
            <Button
              label={primary.label}
              icon="forward"
              fullwidth
              onPress={primary.onPress}
              testID={testID ? `${testID}-primary` : undefined}
            />
          )}
        </View>
      </Pressable>
    </View>
  );
}
