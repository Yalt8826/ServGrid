/**
 * `alpha` suite. The tint helper is one regex and three parses, so the
 * cases that matter are the edges: the shorthand form, the clamp, and the
 * passthrough that keeps a mistyped token from taking the app down.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alpha } from './alpha.ts';
import { COLORS, SEMANTIC, STATUS } from './tokens.ts';

describe('alpha — the tint helper', () => {
  it('expands the six-digit form to rgba', () => {
    assert.equal(alpha('#0F8A5F', 0.14), 'rgba(15,138,95,0.14)');
    assert.equal(alpha(SEMANTIC.bg.dark, 0.08), 'rgba(22,32,43,0.08)');
  });

  it('expands the three-digit shorthand', () => {
    assert.equal(alpha('#FFF', 0.5), 'rgba(255,255,255,0.5)');
  });

  it('is case- and whitespace-insensitive', () => {
    assert.equal(alpha('  #0F8A5F ', 1), 'rgba(15,138,95,1)');
  });

  it('clamps opacity into 0..1 rather than emitting an invalid rgba()', () => {
    assert.equal(alpha('#16202B', 1.4), 'rgba(22,32,43,1)');
    assert.equal(alpha('#16202B', -1), 'rgba(22,32,43,0)');
  });

  it('returns an unparseable value untouched — a token read at module scope never throws', () => {
    assert.equal(alpha('not-a-colour', 0.2), 'not-a-colour');
    assert.equal(alpha('rgba(1,2,3,0.5)', 0.2), 'rgba(1,2,3,0.5)');
  });

  it('tints every status at the chip opacity, none of them opaque', () => {
    for (const ink of [STATUS.completed, STATUS.en_route, STATUS.cancelled, STATUS.unassigned, COLORS.accent]) {
      const tint = alpha(ink, 0.14);
      assert.match(tint, /^rgba\(\d+,\d+,\d+,0\.14\)$/, `${ink} → ${tint}`);
    }
  });
});
