/**
 * O6 Contracts — the detail (UI/plan-2/07-OWNER.md §O6). Header facts,
 * then the **visit schedule**: every visit with its status and, where a
 * visit produced multiple job cards, **all the attempts**. A visit on
 * its third attempt is the thing the owner wants to see when a customer
 * complains — so the attempts render as the visit's own list, each with
 * its number, status and technician, and the multi-attempt visits are
 * called out at the visit level.
 *
 * Pure UI over injected data; the data seam owns the reads.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import {
  isMultiAttempt,
  visitLabel,
  type ContractRow,
  type ContractVisitRow,
} from './model';

export interface OwnerContractDetailScreenProps {
  contract: ContractRow | null;
  visits: ContractVisitRow[];
  error: string | null;
  loading: boolean;
  onOpenJob: (jobId: string) => void;
  onRetry: () => void;
  testID?: string;
}

const VISIT_TONE: Record<string, string> = {
  scheduled: SEMANTIC.text.secondary,
  completed: SEMANTIC.feedback.success,
  skipped: SEMANTIC.feedback.danger,
  overdue: SEMANTIC.feedback.warning,
};

export function OwnerContractDetailScreen(props: OwnerContractDetailScreenProps): React.ReactNode {
  const nowYear = new Date().getFullYear();
  const c = props.contract;

  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'owner-contract-detail'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-contract-detail-error" />
      ) : null}

      {c !== null ? (
        <View testID="contract-header">
          <Text style={styles.number} testID="contract-detail-number">
            {c.contractNumber ?? 'Draft'}
          </Text>
          <Text style={styles.site} testID="contract-detail-site">
            {c.site}
          </Text>
          <Text style={styles.meta}>
            {`${c.billing === 'upfront' ? 'Prepaid' : 'Billed per visit'} · ₹${formatMoneyEnIN(c.value)}`}
          </Text>
          <Text style={styles.meta} testID="contract-detail-term">
            {`${formatDateEnIN(c.startDate, nowYear)} → ${formatDateEnIN(c.endDate, nowYear)}`}
          </Text>
          <Text style={styles.meta} testID="contract-detail-sold-by">
            {`Sold by ${c.soldByName ?? '—'}`}
          </Text>
          <Text style={styles.visits} testID="contract-detail-visits">
            {`${c.visitsUsed} of ${c.visitsIncluded} visits used`}
          </Text>
        </View>
      ) : null}

      <Text style={styles.sectionLabel}>VISIT SCHEDULE</Text>
      {props.visits.map((visit) => (
        <View key={visit.id} style={styles.visit} testID={`visit-${visit.id}`}>
          <View style={styles.visitHead}>
            <Text style={styles.visitLabel} testID={`visit-label-${visit.id}`}>
              {visitLabel(visit)}
            </Text>
            <Text
              style={[styles.visitStatus, { color: VISIT_TONE[visit.status] ?? SEMANTIC.text.secondary }]}
              testID={`visit-status-${visit.id}`}
            >
              {visit.status}
            </Text>
            <Text style={styles.visitDue} testID={`visit-due-${visit.id}`}>
              {formatDateEnIN(visit.dueDate, nowYear)}
            </Text>
          </View>
          {isMultiAttempt(visit) ? (
            <Text style={styles.attemptsNote} testID={`visit-attempts-note-${visit.id}`}>
              {`${visit.attempts.length} attempts — every job card this visit produced:`}
            </Text>
          ) : null}
          {visit.attempts.map((attempt, index) => (
            <View key={attempt.jobId} style={styles.attempt} testID={`visit-attempt-${visit.id}-${index}`}>
              <Text style={styles.attemptOrdinal}>{`Attempt ${index + 1}`}</Text>
              <Text style={styles.attemptNumber} testID={`attempt-job-${visit.id}-${index}`}>
                {attempt.jobNumber}
              </Text>
              <Text style={[styles.attemptStatus, { color: VISIT_TONE[attempt.status] ?? SEMANTIC.text.secondary }]}>
                {attempt.status}
              </Text>
              {attempt.technicianName !== null ? <Text style={styles.attemptTech}>{attempt.technicianName}</Text> : null}
            </View>
          ))}
        </View>
      ))}
      {props.visits.length === 0 && props.error === null ? (
        <Text style={styles.emptyLine} testID="contract-visits-empty">
          No visits scheduled yet.
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  number: {
    ...textStyle('mono'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  site: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
  },
  meta: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
  },
  visits: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
    marginTop: SPACE[1],
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[3],
    marginBottom: SPACE[1],
  },
  visit: {
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[1],
  },
  visitHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
  },
  visitLabel: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
    flex: 1,
  },
  visitStatus: {
    ...textStyle('label'),
  },
  visitDue: {
    ...textStyle('mono'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums'],
    width: 88,
    textAlign: 'right',
  },
  attemptsNote: {
    ...textStyle('caption'),
    color: SEMANTIC.feedback.warning,
  },
  attempt: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 36,
    paddingLeft: SPACE[4],
    gap: SPACE[2],
  },
  attemptOrdinal: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    width: 72,
  },
  attemptNumber: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
    flex: 1,
  },
  attemptStatus: {
    ...textStyle('caption'),
  },
  attemptTech: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    width: 110,
    textAlign: 'right',
  },
  emptyLine: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    paddingVertical: SPACE[2],
  },
});
