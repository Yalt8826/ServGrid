/**
 * JobCard tests (§T2 list card). The card is the most-seen object in the
 * product; this file holds its pure decisions — the contract chip first
 * (T2B.3): an AMC job's card carries the single word `AMC` (§T2 chip is
 * `[AMC]`), an ordinary job carries no chip at all. The number and end
 * date live on the detail screen, never the card.
 *
 * T2B.5 pins the chip's COLOUR too: the AMC chip reads the muted token
 * (`SEMANTIC.text.secondary` on the dense card ground, PLAN-FRONTEND.md
 * §8), never the accent — accent is for the primary action and the
 * active state only, and an accent chip on every AMC card would spend
 * the one accent on a label. Asserted against the RENDERED node, the way
 * a style regression would actually show.
 */
import { describe, expect, it } from 'vitest';

import { COLORS, SEMANTIC } from '@servgrid/shared';
import { create, findAll, toJson, type Node } from '../ui/testing';
import { contractChipLabel, JobCard } from './JobCard';
import type { JobView } from '../../screens/technician/jobView';

let seq = 0;

function viewOf(contract: { number: string; endDate: string } | null): JobView {
  seq += 1;
  return {
    job: {
      id: `01890a5e-7800-7000-8000-${String(seq).padStart(12, '0')}`,
      jobNumber: 'JC-2627-00042',
      title: 'Battery swap',
      status: 'in_progress',
      priority: 'normal',
      scheduledFor: '2026-09-11T14:30:00+05:30',
      customerId: '01890a5e-c000-7000-8000-000000000001',
      contactName: 'Mr Prakash',
      contactPhone: '+919812345678',
      description: null,
      contract,
      version: 3,
    },
    customerName: 'Sunrise Apartments',
    area: 'Kormangala 3rd Blk',
    coordinates: null,
    pending: false,
    rejectedMessage: null,
  };
}

/** The card's one chip node — the Text whose whole text is the word AMC. */
function amcChipOf(root: Node): Node {
  const hits = findAll(
    root,
    (n) => n.type === 'Text' && (n.children ?? []).filter((c): c is string => typeof c === 'string').join('') === 'AMC',
  );
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

function styleOfNode(node: Node): Record<string, unknown> {
  const raw = node.props.style;
  const parts = (Array.isArray(raw) ? raw : [raw]).filter(
    (part): part is Record<string, unknown> => part !== null && typeof part === 'object',
  );
  return Object.assign({}, ...parts);
}

describe('JobCard — contractChipLabel', () => {
  it('is null without a contract — an ordinary job shows no chip', () => {
    expect(contractChipLabel(null)).toBeNull();
  });

  it("is 'AMC' with a contract — the word alone, never a price or a count", () => {
    expect(contractChipLabel({ number: 'AMC-2627-00031', endDate: '2027-09-14' })).toBe('AMC');
  });
});

describe('JobCard — the AMC chip renders muted, never accent (T2B.5)', () => {
  it('an AMC job renders exactly one chip, in the muted ink on the card ground', async () => {
    const renderer = await create(<JobCard view={viewOf({ number: 'AMC-2627-00031', endDate: '2027-09-14' })} />);
    const chip = amcChipOf(toJson(renderer));
    const style = styleOfNode(chip);

    expect(style.color).toBe(SEMANTIC.text.secondary);
    expect(style.color).not.toBe(COLORS.accent); // the safety-yellow accent, theme.ts's alone
  });

  it('an ordinary job renders no chip Text at all', async () => {
    const renderer = await create(<JobCard view={viewOf(null)} />);
    const tree = toJson(renderer);
    const chips = findAll(
      tree,
      (n) => n.type === 'Text' && (n.children ?? []).filter((c): c is string => typeof c === 'string').join('') === 'AMC',
    );
    expect(chips).toHaveLength(0);
  });
});
