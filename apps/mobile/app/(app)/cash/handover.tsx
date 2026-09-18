/**
 * Cash handover route (UI/plan-2/04-TECHNICIAN.md §T6, 06-SALES-REP.md
 * §S6). The `cash` tab lands here, one tap from anywhere, because a
 * handover skipped at 19:10 is the `missing_submission` row the owner's
 * queue exists to catch.
 *
 * **This file owns the role difference.** Both roles declare on the same
 * screen; the technician's history is the week he can still declare for,
 * the rep's is the whole record (2026-09-18, Yashas: "the sales rep gets
 * the full history whereas the technician gets only the last 7 days
 * history"). The server enforces the same floor on `/v1/cash/handovers/me`
 * — `historyWindowDaysFor` in the cash service, off the token's role — and
 * the client mirrors it so the tab's caption and its contents agree. The
 * route is the only place the two halves of that rule meet.
 *
 * This file is also the seam where the pure `CashScreen` meets the API:
 * the three calls the screen needs, with the amendment carrying its
 * `If-Match: <version>` optimistic-concurrency guard (PLAN-BACKEND.md
 * §10). The calls run directly against the API, like every write in the
 * app (online-only, decision 2026-09-15).
 */
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CashAmendRequest, CashDeclareRequest, CashHandover } from '@servgrid/shared';
import { FRAME } from '@servgrid/shared';
import { api } from '../../../src/lib/api';
import { CashScreen } from '../../../src/screens/cash/CashScreen';
import { HANDOVER_WINDOW_DAYS, istBusinessDate } from '../../../src/screens/cash/handoverModel';
import { useSessionStore } from '../../../src/state/sessionStore';

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  const windowed = actor?.role === 'technician';

  return (
    // The frame's ground, top edge only — the dashboard's treatment: the
    // screen's navy header runs to the status bar, and the bottom inset
    // belongs to the shell that draws the tab bar (2026-09-16).
    <SafeAreaView
      style={{ flex: 1, backgroundColor: FRAME.bg }}
      edges={['top', 'left', 'right']}
    >
      <CashScreen
        today={istBusinessDate(new Date())}
        historyWindowDays={windowed ? HANDOVER_WINDOW_DAYS : undefined}
        loadHistory={async () => {
          const res = await api.request<CashHandover[]>('GET', '/v1/cash/handovers/me');
          if (!res.ok || res.data === null) throw new Error(res.error?.message ?? '');
          return res.data;
        }}
        declare={async (input: CashDeclareRequest) => {
          const res = await api.request<CashHandover>('POST', '/v1/cash/handovers', { body: input });
          if (!res.ok || res.data === null) throw new Error(res.error?.message ?? '');
          return res.data;
        }}
        amend={async (id: string, version: number, input: CashAmendRequest) => {
          const res = await api.request<CashHandover>('PATCH', `/v1/cash/handovers/${id}`, {
            body: input,
            headers: { 'If-Match': String(version) },
          });
          if (!res.ok || res.data === null) throw new Error(res.error?.message ?? '');
          return res.data;
        }}
      />
    </SafeAreaView>
  );
}
