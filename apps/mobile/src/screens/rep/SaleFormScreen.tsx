/**
 * S2 Sales — create (UI/plan-2/06-SALES-REP.md §S2). One screen, no
 * wizard: company search (his accounts + house), date, line items, notes,
 * and the two-button ending.
 *
 * Content decisions the form carries:
 * - **The product picker snapshots name, SKU and price at add time**; the
 *   row shows the snapshot, not a live lookup — a repricing next quarter
 *   must not rewrite this sale.
 * - **The unit price is editable on the line** — a negotiated price is
 *   normal, and the snapshot records what was actually agreed.
 * - **Serial numbers** are an optional per-line field, collapsed.
 * - **The total is computed and displayed** — here it *is* a bill, and
 *   the display equals what `v_sales_card_totals` will define (the sum of
 *   the generated line totals).
 * - The ending: *Save draft* (secondary) and *Confirm sale* (primary).
 *   Confirming moves a balance, so it gets the confirmation step — and
 *   only the owner can void afterwards.
 *
 * Pure UI over injected deps (`SaleFormDeps`); the route owns the calls
 * (draft create, then confirm — the number arrives from the confirm).
 */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Button, ConfirmDialog, DatePicker, haptic, MoneyField, TextField } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { sumMoney } from './money';

export interface PickerCompany {
  id: string;
  name: string;
}

export interface PickerProduct {
  id: string;
  name: string;
  sku: string;
  defaultPrice: string;
}

/** One line, as the form holds it: the snapshot taken at add time. */
export interface SaleFormLine {
  key: string;
  productId: string | null;
  productName: string;
  productSku: string | null;
  /** The snapshot price — editable, because negotiated is normal. */
  quantity: string;
  unitPrice: string;
  serialsOpen: boolean;
  serials: string;
}

export interface SaleFormDeps {
  companies: PickerCompany[];
  products: PickerProduct[];
  /** Today's IST business date — the form's default sale date. */
  today: string;
  initialCompanyId?: string | null;
  createDraft: (input: {
    companyId: string;
    saleDate: string;
    notes?: string;
    items: Array<{
      productId?: string;
      productName: string;
      productSku?: string;
      quantity: number;
      unitPrice: string;
      serialNumbers?: string[];
    }>;
  }) => Promise<{ id: string }>;
  confirmSale: (id: string) => Promise<unknown>;
  /** Called after the draft saved (`confirmed=false`) or confirmed. */
  onDone: (draftId: string, confirmed: boolean) => void;
  testID?: string;
}

let lineSeq = 0;

/** The next line's local key — stable across edits, never a wire id. */
export function nextLineKey(): string {
  lineSeq += 1;
  return `line-${lineSeq}`;
}

/** The wire-format money string for quantity × unit price, rounded to
 * paise — what the server's generated `line_total` will hold. */
export function lineTotalOf(quantity: string, unitPrice: string): string {
  const q = Number(quantity);
  const p = Number(unitPrice);
  if (!Number.isFinite(q) || !Number.isFinite(p) || quantity === '' || unitPrice === '') return '0';
  const paise = Math.round(q * p * 100);
  const abs = Math.abs(paise);
  const int = String(Math.floor(abs / 100));
  const dec = String(abs % 100).padStart(2, '0');
  const sign = paise < 0 ? '-' : '';
  return dec === '00' ? `${sign}${int}` : `${sign}${int}.${dec}`;
}

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
const QUANTITY_PATTERN = /^\d+(\.\d{1,2})?$/;

export function isValidQuantity(raw: string): boolean {
  const n = Number(raw);
  return QUANTITY_PATTERN.test(raw) && n > 0;
}

export function isValidUnitPrice(raw: string): boolean {
  return MONEY_PATTERN.test(raw);
}

/** A line is complete when its product, quantity and price are real. */
export function lineComplete(line: SaleFormLine): boolean {
  return (
    (line.productId !== null || line.productName.trim() !== '') &&
    isValidQuantity(line.quantity) &&
    isValidUnitPrice(line.unitPrice)
  );
}

/** The whole form can go to the wire when the company and every line are. */
export function formComplete(companyId: string | null, lines: readonly SaleFormLine[]): boolean {
  return companyId !== null && lines.length > 0 && lines.every(lineComplete);
}

/** The wire items — the snapshots, serials split and trimmed. */
export function itemsOf(lines: readonly SaleFormLine[]): Array<{
  productId?: string;
  productName: string;
  productSku?: string;
  quantity: number;
  unitPrice: string;
  serialNumbers?: string[];
}> {
  return lines.map((line) => {
    const serials = line.serials
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    return {
      ...(line.productId !== null ? { productId: line.productId } : {}),
      productName: line.productName,
      ...(line.productSku !== null ? { productSku: line.productSku } : {}),
      quantity: Number(line.quantity),
      unitPrice: line.unitPrice,
      ...(serials.length > 0 ? { serialNumbers: serials } : {}),
    };
  });
}

export function SaleFormScreen(deps: SaleFormDeps): React.ReactNode {
  const [companyQuery, setCompanyQuery] = useState('');
  const [companyId, setCompanyId] = useState<string | null>(deps.initialCompanyId ?? null);
  const [companySearchOpen, setCompanySearchOpen] = useState(deps.initialCompanyId == null);
  const [saleDate, setSaleDate] = useState(deps.today);
  const [lines, setLines] = useState<SaleFormLine[]>([]);
  const [productQuery, setProductQuery] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const companyName = useMemo(
    () => deps.companies.find((c) => c.id === companyId)?.name ?? null,
    [companyId, deps.companies],
  );

  const filteredCompanies = useMemo(() => {
    const q = companyQuery.trim().toLowerCase();
    return (q === '' ? deps.companies : deps.companies.filter((c) => c.name.toLowerCase().includes(q))).slice(0, 8);
  }, [companyQuery, deps.companies]);

  const filteredProducts = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    return (q === '' ? deps.products : deps.products.filter((p) => `${p.name} ${p.sku}`.toLowerCase().includes(q))).slice(0, 8);
  }, [productQuery, deps.products]);

  const total = useMemo(() => sumMoney(lines.map((l) => lineTotalOf(l.quantity, l.unitPrice))), [lines]);
  const complete = formComplete(companyId, lines);

  function addProduct(product: PickerProduct): void {
    // The snapshot is taken HERE, at add time: name, SKU, price.
    setLines((current) => [
      ...current,
      {
        key: nextLineKey(),
        productId: product.id,
        productName: product.name,
        productSku: product.sku,
        quantity: '1',
        unitPrice: product.defaultPrice,
        serialsOpen: false,
        serials: '',
      },
    ]);
    setProductQuery('');
  }

  function patchLine(key: string, patch: Partial<SaleFormLine>): void {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: string): void {
    setLines((current) => current.filter((l) => l.key !== key));
  }

  async function submit(confirm: boolean): Promise<void> {
    if (busy || !complete || companyId === null) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedNotes = notes.trim();
      const draft = await deps.createDraft({
        companyId,
        saleDate,
        ...(trimmedNotes === '' ? {} : { notes: trimmedNotes }),
        items: itemsOf(lines),
      });
      if (!confirm) {
        deps.onDone(draft.id, false);
        return;
      }
      await deps.confirmSale(draft.id);
      deps.onDone(draft.id, true);
    } catch (e) {
      setError(e instanceof Error && e.message !== '' ? e.message : 'The sale could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content} testID={deps.testID ?? 'sale-form'}>
      <Text style={styles.heading} testID="sale-form-title">
        New sale
      </Text>

      {error !== null ? (
        <Text style={styles.errorText} testID="sale-form-error">
          {error}
        </Text>
      ) : null}

      <View style={styles.block}>
        <Text style={styles.fieldLabel}>Company</Text>
        {companyName !== null && !companySearchOpen ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setCompanySearchOpen(true)}
            style={styles.companyChosen}
            testID="sale-form-company"
          >
            <Text style={styles.rowPrimary}>{companyName}</Text>
            <Text style={styles.linkLike}>Change</Text>
          </Pressable>
        ) : (
          <View style={styles.searchBlock}>
            <TextField
              label="Search his accounts and house"
              value={companyQuery}
              onChangeText={setCompanyQuery}
              placeholder="Company name"
              testID="sale-form-company-search"
            />
            {filteredCompanies.map((c) => (
              <Pressable
                key={c.id}
                accessibilityRole="button"
                onPress={() => {
                  setCompanyId(c.id);
                  setCompanySearchOpen(false);
                  setCompanyQuery('');
                }}
                style={styles.pickRow}
                testID={`sale-form-company-option-${c.id}`}
              >
                <Text style={styles.rowPrimary}>{c.name}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      <View style={styles.block}>
        <DatePicker label="Date" value={saleDate} onChange={setSaleDate} testID="sale-form-date" />
      </View>

      <Text style={styles.sectionLabel}>LINE ITEMS</Text>
      {lines.map((line) => (
        <View key={line.key} style={styles.line} testID={`sale-form-line-${line.key}`}>
          <View style={styles.lineHead}>
            <View style={styles.lineMain}>
              <Text style={styles.rowPrimary}>{line.productName}</Text>
              <Text style={styles.snapshot}>
                {`${line.productSku ?? ''} · snapshot ₹${formatMoneyEnIN(line.unitPrice)}`}
              </Text>
            </View>
            <Button label="Remove" variant="ghost" onPress={() => removeLine(line.key)} testID={`sale-form-line-remove-${line.key}`} />
          </View>
          <View style={styles.lineFields}>
            <View style={styles.quantityCell}>
              <TextField
                label="Qty"
                value={line.quantity}
                onChangeText={(t) => patchLine(line.key, { quantity: t })}
                testID={`sale-form-line-qty-${line.key}`}
              />
            </View>
            <View style={styles.priceCell}>
              <MoneyField
                label="Unit price"
                value={line.unitPrice}
                onChangeText={(t) => patchLine(line.key, { unitPrice: t })}
                helperText="Negotiated price is normal — the line records what was agreed."
                testID={`sale-form-line-price-${line.key}`}
              />
            </View>
          </View>
          <Text style={styles.lineTotal} testID={`sale-form-line-total-${line.key}`}>
            {`= ₹${formatMoneyEnIN(lineTotalOf(line.quantity, line.unitPrice))}`}
          </Text>
          {line.serialsOpen ? (
            <TextField
              label="Serial numbers (comma separated)"
              value={line.serials}
              onChangeText={(t) => patchLine(line.key, { serials: t })}
              testID={`sale-form-line-serials-${line.key}`}
            />
          ) : (
            <Button
              label="Add serial numbers"
              variant="ghost"
              onPress={() => patchLine(line.key, { serialsOpen: true })}
              testID={`sale-form-line-serials-open-${line.key}`}
            />
          )}
        </View>
      ))}

      <Text style={styles.fieldLabel}>Add a product</Text>
      <TextField
        label="Search products"
        value={productQuery}
        onChangeText={setProductQuery}
        placeholder="Name or SKU"
        testID="sale-form-product-search"
      />
      {filteredProducts.map((p) => (
        <Pressable
          key={p.id}
          accessibilityRole="button"
          onPress={() => addProduct(p)}
          style={styles.pickRow}
          testID={`sale-form-product-option-${p.id}`}
        >
          <Text style={styles.rowPrimary}>{`${p.name} · ${p.sku}`}</Text>
          <Text style={styles.rowMoney}>{`₹${formatMoneyEnIN(p.defaultPrice)}`}</Text>
        </Pressable>
      ))}

      <View style={styles.totalRow} testID="sale-form-total">
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalValue}>{`₹${formatMoneyEnIN(total)}`}</Text>
      </View>

      <View style={styles.block}>
        <TextField
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Anything the bill should say"
          multiline
          rows={2}
          testID="sale-form-notes"
        />
      </View>

      {/* The two-button ending (§S2). */}
      <View style={styles.ending}>
        <Button
          label="Save draft"
          variant="secondary"
          onPress={() => void submit(false)}
          loading={busy}
          disabled={!complete}
          disabledReason="Pick the company and add at least one complete line."
          fullwidth
          testID="sale-form-save-draft"
        />
        <Button
          label="Confirm sale"
          onPress={() => {
            haptic('primaryActionPress');
            setConfirming(true);
          }}
          disabled={!complete}
          disabledReason="Pick the company and add at least one complete line."
          fullwidth
          testID="sale-form-confirm"
        />
      </View>

      <ConfirmDialog
        visible={confirming}
        title="Confirm sale"
        message={`Confirming allocates the sale number and moves ${companyName ?? "the company's"} balance by ₹${formatMoneyEnIN(
          total,
        )}. Only the owner can void it afterwards.`}
        confirmLabel="Confirm sale"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void submit(true);
        }}
        testID="sale-form-confirm-dialog"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[3],
  },
  heading: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
  },
  block: {
    gap: SPACE[2],
  },
  searchBlock: {
    gap: SPACE[1],
  },
  fieldLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[2],
  },
  companyChosen: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingVertical: SPACE[2],
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: SPACE[2],
    borderRadius: 4,
    gap: SPACE[3],
  },
  line: {
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    padding: SPACE[3],
    gap: SPACE[2],
  },
  lineHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE[2],
  },
  lineMain: {
    flex: 1,
    gap: 2,
  },
  snapshot: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  lineFields: {
    flexDirection: 'row',
    gap: SPACE[3],
  },
  quantityCell: {
    width: 96,
  },
  priceCell: {
    flex: 1,
  },
  lineTotal: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACE[2],
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.strong,
  },
  totalLabel: {
    ...textStyle('h2'),
    color: SEMANTIC.text.primary,
  },
  totalValue: {
    ...textStyle('display'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  ending: {
    gap: SPACE[3],
    marginTop: SPACE[2],
  },
  rowPrimary: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    flex: 1,
  },
  rowMoney: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  linkLike: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  errorText: {
    ...textStyle('body'),
    color: SEMANTIC.feedback.danger,
  },
});
