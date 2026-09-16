/**
 * Cash handover route (UI/plan-2/04-TECHNICIAN.md §T6). The technician's
 * (and later the rep's) own declaration — the `cash` tab lands here, one
 * tap from anywhere, because a handover skipped at 19:10 is the
 * `missing_submission` row the owner's queue exists to catch.
 *
 * This file is the seam where the pure `HandoverScreen` meets the API:
 * the three calls the screen needs, with the amendment carrying its
 * `If-Match: <version>` optimistic-concurrency guard (PLAN-BACKEND.md
 * §10). The calls run directly against the API, like every write in the
 * app (online-only, decision 2026-09-15).
 */
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CashAmendRequest, CashDeclareRequest, CashHandover } from '@servgrid/shared';
import { FRAME } from '@servgrid/shared';
import { api } from '../../../src/lib/api';
import { HandoverScreen, istBusinessDate } from '../../../src/screens/technician/HandoverScreen';

export default function Screen() {
  return (
    // The frame's ground, top edge only — the dashboard's treatment: the
    // screen's navy header runs to the status bar, and the bottom inset
    // belongs to the shell that draws the tab bar (2026-09-16).
    <SafeAreaView
      style={{ flex: 1, backgroundColor: FRAME.bg }}
      edges={['top', 'left', 'right']}
    >
      <HandoverScreen
        today={istBusinessDate(new Date())}
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
