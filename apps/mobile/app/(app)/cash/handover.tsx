/**
 * Cash handover route (UI/plan-2/04-TECHNICIAN.md §T6). The technician's
 * (and later the rep's) own declaration — the `cash` tab lands here, one
 * tap from anywhere, because a handover skipped at 19:10 is the
 * `missing_submission` row the owner's queue exists to catch.
 *
 * This file is the seam where the pure `HandoverScreen` meets the API:
 * the three calls the screen needs, with the amendment carrying its
 * `If-Match: <version>` optimistic-concurrency guard (PLAN-BACKEND.md
 * §10). The offline queue is T1.14's outbox; until that task lands these
 * calls run directly, and the screen's seams make rewiring to enqueue a
 * route-file change only.
 */
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CashAmendRequest, CashDeclareRequest, CashHandover } from '@servgrid/shared';
import { SEMANTIC } from '@servgrid/shared';
import { api } from '../../../src/lib/api';
import { HandoverScreen, istBusinessDate } from '../../../src/screens/technician/HandoverScreen';

export default function Screen() {
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
      edges={['top', 'left', 'right', 'bottom']}
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
