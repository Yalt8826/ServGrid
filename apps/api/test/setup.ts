import { loadDotEnv } from '../src/config.js';

// Local runs pick up the repo-root .env (the one compose reads) so a
// non-default SERVGRID_DB_PORT reaches the suites; CI exports its own
// variables and Node never overrides one that is already set.
loadDotEnv();
