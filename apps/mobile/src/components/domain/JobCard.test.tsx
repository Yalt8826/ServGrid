/**
 * JobCard tests (§T2 list card). The card is the most-seen object in the
 * product; this file holds its pure decisions — the contract chip first
 * (T2B.3): an AMC job's card carries the single word `AMC` (§T2 chip is
 * `[AMC]`), an ordinary job carries no chip at all. The number and end
 * date live on the detail screen, never the card.
 */
import { describe, expect, it } from 'vitest';

import { contractChipLabel } from './JobCard';

describe('JobCard — contractChipLabel', () => {
  it('is null without a contract — an ordinary job shows no chip', () => {
    expect(contractChipLabel(null)).toBeNull();
  });

  it("is 'AMC' with a contract — the word alone, never a price or a count", () => {
    expect(contractChipLabel({ number: 'AMC-2627-00031', endDate: '2027-09-14' })).toBe('AMC');
  });
});
