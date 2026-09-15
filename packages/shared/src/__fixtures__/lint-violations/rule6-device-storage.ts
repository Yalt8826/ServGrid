// Rule 4 fixture — must produce exactly one `no-device-storage` error.
// A module outside the two exceptions keeping data on the phone.
declare const localStorage: { setItem(key: string, value: string): void };

export function rememberLastJob(jobId: string): void {
  localStorage.setItem('servgrid.lastJob', jobId);
}
