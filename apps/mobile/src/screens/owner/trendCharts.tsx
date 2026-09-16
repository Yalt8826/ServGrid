/**
 * The dashboard's two long-view charts — NATIVE (OW.5).
 *
 * Metro resolves `trendCharts.web.tsx` for the browser, where Recharts
 * draws them with hover and readable axes. On the owner's phone the
 * hand-drawn charts from T4.8 stand: no library reaches the APK, and the
 * phone keeps a chart that was built for its width.
 */
export { JobsPerDayBarChart, RevenuePerWeekLineChart } from './charts';
