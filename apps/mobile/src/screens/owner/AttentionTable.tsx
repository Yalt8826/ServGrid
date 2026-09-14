/**
 * The attention feed's native seam (T4.8, PLAN-FRONTEND.md §8). The desk
 * presentation is `AttentionTable.web.tsx` — DataTable has no native
 * counterpart and must never enter the APK — so the import the owner
 * screen writes (`./AttentionTable`) resolves by platform: the web file
 * on web, this one on native.
 *
 * On the handset, desk density never occurs (NavShell's single platform
 * branch is web-and-≥1024 only), so this file is unreachable at runtime.
 * It exists so the screen's import graph resolves on native while
 * degrading to the row feed — the honest fallback that keeps FlashList
 * out of the bundle, exactly the construction the DataTable suite proves
 * with its Metro resolution test.
 */
import { AttentionRows } from './AttentionRows';
import type { AttentionRowVm } from './model';

export function AttentionTable({
  rows,
  onOpen,
}: {
  rows: AttentionRowVm[];
  onOpen: (target: string) => void;
}): React.ReactNode {
  return <AttentionRows rows={rows} onOpen={onOpen} testIDPrefix="owner-attention-row" />;
}
