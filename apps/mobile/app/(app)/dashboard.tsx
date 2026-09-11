/**
 * Dashboard — the technician's landing route (PLAN-FRONTEND.md §2, §5.1).
 *
 * T1.15 scope: this is the screen the offline cold start must land on.
 * It renders THE MIRROR and nothing else — no fetch sits in front of the
 * first frame, no spinner stands in for content the phone already has
 * (Part D: "a skeleton there would be a lie about the architecture").
 * While the mirror opens (a local read, at most a frame) the screen is
 * simply quiet; when the mirror has never been synced it says so.
 *
 * The three-figure layout, NEXT card, tracking chip and pull-to-refresh
 * are T1.17's (`UI/plan-2/04-TECHNICIAN.md` §T1); this file exists to
 * prove the pipe — stored session in, mirrored jobs out, radio off.
 */
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Mirror } from '../../src/db/mirror';
import { SEMANTIC } from '@servgrid/shared';
import { textStyle } from '../../src/fonts/textStyle';
import { useMirrorSession } from '../../src/sync/MirrorProvider';

interface DashboardJob {
  id: string;
  jobNumber: string;
  title: string;
  status: string;
  scheduledFor: string | null;
  customerName: string | null;
}

/**
 * The mirror read, and the only query in the cold-start path: local
 * SQLite, synchronous, tens of rows. The network is not involved — an
 * expired access token is irrelevant here, which is the entire point.
 */
export function readDashboardJobs(mirror: Mirror): DashboardJob[] {
  const rows = mirror.database.getAllSync<{
    id: string;
    jobNumber: string;
    title: string;
    status: string;
    scheduledFor: string | null;
    customerName: string | null;
  }>(
    `SELECT j.id AS id, j.job_number AS jobNumber, j.title AS title, j.status AS status,
            j.scheduled_for AS scheduledFor, c.name AS customerName
     FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
     ORDER BY (j.scheduled_for IS NULL), j.scheduled_for, j.job_number`,
  );
  return rows;
}

/** "Today" / "Yesterday" / a short date — the day buckets §T1 sorts by.
 * An unreadable stamp degrades to "Unscheduled" rather than hiding the job. */
export function dayLabel(iso: string | null): string {
  if (iso === null) return 'Unscheduled';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return 'Unscheduled';
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(when) - startOfDay(new Date())) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === -1) return 'Yesterday';
  if (days === 1) return 'Tomorrow';
  return when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

interface Section {
  label: string;
  jobs: DashboardJob[];
}

function sectionsOf(jobs: readonly DashboardJob[]): Section[] {
  const sections: Section[] = [];
  for (const job of jobs) {
    const label = dayLabel(job.scheduledFor);
    const last = sections[sections.length - 1];
    if (last !== undefined && last.label === label) {
      last.jobs.push(job);
    } else {
      sections.push({ label, jobs: [job] });
    }
  }
  return sections;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  title: { ...textStyle('display'), color: SEMANTIC.text.primary, marginTop: 16, marginBottom: 4 },
  sectionHeader: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginTop: 20,
    marginBottom: 8,
  },
  card: {
    backgroundColor: SEMANTIC.bg.raised,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  cardTitle: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  cardMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary, marginTop: 2 },
  jobNumber: { ...textStyle('mono'), color: SEMANTIC.text.secondary, marginBottom: 2 },
  empty: { ...textStyle('body'), color: SEMANTIC.text.secondary, marginTop: 24 },
});

export default function Screen() {
  const session = useMirrorSession();
  // The revision re-reads the mirror after each background sync cycle;
  // the read itself never touches the network.
  const revision = session?.revision ?? 0;
  const jobs = useMemo(
    () => (session === null ? [] : readDashboardJobs(session.mirror)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision is the re-read signal
    [session, revision],
  );
  const sections = useMemo(() => sectionsOf(jobs), [jobs]);

  return (
    <SafeAreaView
      testID="(app)/dashboard"
      style={styles.root}
      edges={['top', 'left', 'right', 'bottom']}
    >
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Dashboard</Text>

        {session === null ? (
          // The mirror is opening — a local read, never a spinner: the
          // next frame either has the data or the honest empty state.
          null
        ) : sections.length === 0 ? (
          <Text style={styles.empty}>
            No jobs on this phone yet — they appear after the first sync.
          </Text>
        ) : (
          sections.map((section) => (
            <View key={section.label}>
              <Text style={styles.sectionHeader}>{section.label}</Text>
              <View testID="mirror-jobs">
                {section.jobs.map((job) => (
                  <View key={job.id} testID="mirror-job-row" style={styles.card}>
                    <Text style={styles.jobNumber}>
                      {job.jobNumber !== '' ? job.jobNumber : 'Pending sync'}
                    </Text>
                    <Text style={styles.cardTitle}>{job.title}</Text>
                    <Text style={styles.cardMeta}>
                      {[job.customerName ?? null, job.status].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
