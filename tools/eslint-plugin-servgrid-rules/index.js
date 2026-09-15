/**
 * Custom eslint rules carrying real guarantees (PLAN-BACKEND.md §13).
 * Loaded as the `servgrid-rules` plugin from .eslintrc.cjs and proven by
 * the fixtures under packages/shared/src/__fixtures__/lint-violations/
 * plus tools/lint-proof.mjs. These are not style rules: rule 1 is the
 * accent-erosion defence, rule 2 the revenue-leak defence — narrowed by
 * decision 2026-09-15 to `job_completions` alone, because the AMC price
 * (`service_contracts.contract_value`) is now the dispatcher's own figure,
 * while job revenue never is — rule 3 keeps
 * the `location.health` / `location.read` split from eroding, and rule 4
 * keeps business data off the phone (online-only, decision 2026-09-15).
 */
'use strict';

const ACCENT_HEX_RE = /#F2C200/i;

/** True for the one file per platform allowed to carry the literal. */
function isThemeFile(filename) {
  const base = String(filename || '').split(/[\\/]/).pop().toLowerCase();
  return base === 'theme.ts';
}

const ACCENT_MESSAGE =
  'Accent colour must be imported from a theme.ts — literal hex #F2C200 (case-insensitive) is not allowed here.';

const accentRule = {
  meta: { type: 'problem', docs: { description: 'no literal #F2C200 outside theme.ts' }, schema: [] },
  create(context) {
    const banned = !isThemeFile(context.getFilename ? context.getFilename() : '');
    return {
      Literal(node) {
        if (banned && typeof node.value === 'string' && ACCENT_HEX_RE.test(node.value)) {
          context.report({ node, message: ACCENT_MESSAGE });
        }
      },
      JSXText(node) {
        if (banned && typeof node.value === 'string' && ACCENT_HEX_RE.test(node.value)) {
          context.report({ node, message: ACCENT_MESSAGE });
        }
      },
      TemplateElement(node) {
        if (
          banned &&
          node.value &&
          typeof node.value.cooked === 'string' &&
          ACCENT_HEX_RE.test(node.value.cooked)
        ) {
          context.report({ node, message: ACCENT_MESSAGE });
        }
      },
    };
  },
};

/**
 * Factory for the two repo.dispatcher.ts guards. Matches table names in
 * SQL text (FROM/JOIN clauses) inside string literals and template
 * literals; case-insensitive, schema-qualified names allowed.
 *
 * Config: the set of file basenames the rule applies to.
 *   'servgrid-rules/no-sql-money-tables': ['error', ['repo.dispatcher.ts']]
 *
 * Deliberate scope note: the rule reads literal SQL text. A query that
 * hides a table name behind `${someVariable}` is written to evade the
 * rule, and code review — not a lint rule — is the defence for that.
 */
function makeNoSqlTablesRule(tableNameSet, messageText) {
  return {
    meta: {
      type: 'problem',
      docs: { description: messageText },
      schema: [{ type: 'array', items: { type: 'string' }, minItems: 1 }],
    },
    create(context) {
      const config = context.options && context.options[0];
      const filenames = Array.isArray(config) ? config : config && config.filenames;
      if (!Array.isArray(filenames) || filenames.length === 0) return {};
      const targets = filenames.map((p) => String(p).toLowerCase());
      const isTarget = (f) => targets.some((t) => f === t || f.endsWith(`/${t}`));

      const checkString = (node, raw) => {
        if (typeof raw !== 'string' || !isTarget(context.getFilename())) return;
        const found = new Set();
        for (const m of raw.matchAll(/(?:\bFROM\s+|\bJOIN\s+)([A-Za-z_][\w.]*)/gi)) {
          const name = m[1].split('.').pop().toLowerCase();
          if (tableNameSet.has(name)) found.add(name);
        }
        for (const name of found) {
          context.report({ node, message: `${messageText} (table "${name}")` });
        }
      };

      return {
        Literal(node) {
          checkString(node, node.value);
        },
        TemplateElement(node) {
          if (node.value) checkString(node, node.value.cooked);
        },
      };
    },
  };
}

const MONEY_TABLES = new Set(['job_completions']);
const MONEY_MESSAGE =
  'repo.dispatcher.ts must not reference job_completions — dispatcher queries read the dispatcher views only (revenue-leak defence). The AMC price is the dispatcher\'s by decision (2026-09-15); job revenue never is.';

const LOCATION_TABLES = new Set(['location_pings', 'location_requests']);
const LOCATION_MESSAGE =
  'repo.dispatcher.ts must not reference location_pings or location_requests — a dispatcher may know a device went quiet, never where anyone is (location.health / location.read split).';

/**
 * Rule 4 — no device storage outside the two named exceptions
 * (docs/decisions/2026-09-15-online-only.md). The app is online-only: the
 * login token and the unsent-GPS buffer are the only things a phone keeps.
 * Any other module importing a storage API, or reaching for
 * `localStorage` / `sessionStorage` / `indexedDB`, is an error.
 *
 * Config: the file basenames allowed to touch storage.
 *   'servgrid-rules/no-device-storage': ['error', ['tokenStore.impl.native.ts', …]]
 *
 * Tests and test stubs are exempt: they run under vitest on a workstation,
 * never on a phone.
 */
const STORAGE_MODULES = new Set(['expo-sqlite', 'expo-secure-store', '@react-native-async-storage/async-storage']);
const STORAGE_GLOBALS = new Set(['localStorage', 'sessionStorage', 'indexedDB']);
const STORAGE_HOSTS = new Set(['window', 'globalThis', 'self']);
const STORAGE_MESSAGE =
  'Nothing is stored on the device except the login token and the GPS buffer — this module may not use device storage (online-only decision, 2026-09-15).';

const noDeviceStorageRule = {
  meta: {
    type: 'problem',
    docs: { description: STORAGE_MESSAGE },
    schema: [{ type: 'array', items: { type: 'string' } }],
  },
  create(context) {
    const filename = String(context.getFilename ? context.getFilename() : '').replace(/\\/g, '/');
    const allowed = (context.options && context.options[0]) || [];
    const base = filename.split('/').pop();
    if (allowed.includes(base)) return {};
    if (/\.test\.tsx?$/.test(filename) || filename.includes('/test-stubs/')) return {};

    const report = (node, what) => context.report({ node, message: `${STORAGE_MESSAGE} (${what})` });
    return {
      ImportDeclaration(node) {
        if (STORAGE_MODULES.has(node.source.value)) report(node, node.source.value);
      },
      CallExpression(node) {
        const arg = node.arguments[0];
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          arg &&
          arg.type === 'Literal' &&
          STORAGE_MODULES.has(arg.value)
        ) {
          report(node, arg.value);
        }
      },
      MemberExpression(node) {
        if (node.computed) return;
        if (node.object.type === 'Identifier' && STORAGE_GLOBALS.has(node.object.name)) {
          report(node, node.object.name);
        } else if (
          node.object.type === 'Identifier' &&
          STORAGE_HOSTS.has(node.object.name) &&
          node.property.type === 'Identifier' &&
          STORAGE_GLOBALS.has(node.property.name) &&
          !(node.parent && node.parent.type === 'MemberExpression' && node.parent.object === node && false)
        ) {
          report(node, `${node.object.name}.${node.property.name}`);
        }
      },
    };
  },
};

module.exports = {
  rules: {
    'no-accent-hex': accentRule,
    'no-sql-money-tables': makeNoSqlTablesRule(MONEY_TABLES, MONEY_MESSAGE),
    'no-sql-location-tables': makeNoSqlTablesRule(LOCATION_TABLES, LOCATION_MESSAGE),
    'no-device-storage': noDeviceStorageRule,
  },
};
