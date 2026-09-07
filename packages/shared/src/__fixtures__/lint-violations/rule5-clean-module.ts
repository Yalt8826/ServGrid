/**
 * Control — an ordinary module that must stay clean under all three
 * custom rules: imported theme token, plain domain table, no
 * dispatcher-repo filename.
 */
import { STATUS } from '../../theme';

/** Ordinary domain query — legal anywhere. */
export const openJobs = 'SELECT id FROM job_cards WHERE status <> \'completed\'';

/** The accent is referenced by import, never by literal. */
export const inProgressColor = STATUS.inProgress;
