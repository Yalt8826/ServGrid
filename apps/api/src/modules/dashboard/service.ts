import { getPool } from '../../db/pool.js';
import type { AttentionItem } from './schemas.js';
import type {
  OwnerAttentionResponse,
  OwnerDashboardResponse,
  OwnerPerformanceResponse,
  PerformanceRangeKey,
} from './schemas.js';
import * as repo from './repo.js';

/**
 * Owner dashboard service (PHASE-4-OWNER.md T4.6). The service is a
 * mapper, not a calculator: every number arrives from the view that owns
 * its definition, and the only transformation here is Postgres `bigint`
 * text and `timestamptz` becoming JSON numbers and ISO strings — the same
 * convention the dispatcher summary runs under. Computing a figure here
 * would be exactly the second definition the endpoint exists to refuse.
 */
export function createDashboardService() {
  /**
   * GET /v1/dashboard/owner/performance (OW.3) — the four charts in one
   * read, over one range. The mapper's only work is Postgres text
   * becoming JSON: counts to numbers, money left as the decimal strings
   * the schema carries everywhere else.
   */
  async function ownerPerformance(range: PerformanceRangeKey): Promise<OwnerPerformanceResponse> {
    const db = getPool();
    const bounds = await repo.performanceRange(db, range);
    const [days, technicians, reps, techRevenue, techJobs, salesValue, salesCount] = await Promise.all([
      repo.daysIn(db, bounds),
      repo.performancePeople(db, 'technician', bounds),
      repo.performancePeople(db, 'sales_rep', bounds),
      repo.technicianRevenueSeries(db, bounds),
      repo.technicianJobsSeries(db, bounds),
      repo.repSalesValueSeries(db, bounds),
      repo.repSalesCountSeries(db, bounds),
    ]);

    const money = (rows: repo.SeriesPointRow[]) =>
      rows.map((row) => ({ date: row.date, employeeId: row.employee_id, value: row.value }));
    const counted = (rows: repo.SeriesPointRow[]) =>
      rows.map((row) => ({ date: row.date, employeeId: row.employee_id, count: Number(row.value) }));
    const people = (rows: repo.EmployeeRow[]) => rows.map((row) => ({ id: row.id, name: row.full_name }));

    return {
      range: { key: range, from: bounds.from, to: bounds.to },
      days,
      technicians: people(technicians),
      reps: people(reps),
      technicianRevenue: money(techRevenue),
      technicianJobs: counted(techJobs),
      repSalesValue: money(salesValue),
      repSalesCount: counted(salesCount),
    };
  }

  async function ownerDashboard(): Promise<OwnerDashboardResponse> {
    const db = getPool();
    const [openJobs, cashAwaiting, mtdRevenue, dues, perDay, perWeek] = await Promise.all([
      repo.countOpenJobsByStatusToday(db),
      repo.sumCashAwaitingConfirmation(db),
      repo.sumMonthToDateRevenue(db),
      repo.sumOutstandingCompanyDues(db),
      repo.jobsPerDay(db),
      repo.revenuePerWeek(db),
    ]);

    return {
      openJobsByStatusToday: {
        unassigned: Number(openJobs.unassigned),
        assigned: Number(openJobs.assigned),
        enRoute: Number(openJobs.en_route),
        inProgress: Number(openJobs.in_progress),
      },
      cashAwaitingConfirmation: cashAwaiting,
      monthToDateRevenue: mtdRevenue,
      outstandingCompanyDues: dues,
      jobsPerDay: perDay.map((row) => ({ date: row.day, jobs: Number(row.jobs) })),
      revenuePerWeek: perWeek.map((row) => ({ weekStart: row.week_start, revenue: row.revenue })),
    };
  }

  async function ownerAttention(): Promise<OwnerAttentionResponse> {
    const rows = await repo.attentionFeed(getPool());
    // The SQL has already applied the consequence order (repo.ts); the
    // mapping is one-to-one and preserves it.
    const items: AttentionItem[] = rows.map((row) => ({
      category: row.category,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      businessDate: row.business_date,
      expectedCash: row.expected_cash,
      declaredAmount: row.declared_amount,
      variance: row.variance,
      jobId: row.job_id,
      jobNumber: row.job_number,
      jobTitle: row.job_title,
      jobStatus: row.job_status,
      scheduledDate: row.scheduled_date,
      customerName: row.customer_name,
      health: row.health,
      lastPingAt: row.last_ping_at === null ? null : new Date(row.last_ping_at).toISOString(),
      contractId: row.contract_id,
      contractNumber: row.contract_number,
      contractEndDate: row.contract_end_date,
    }));
    return { items };
  }

  return { ownerDashboard, ownerAttention, ownerPerformance };
}
