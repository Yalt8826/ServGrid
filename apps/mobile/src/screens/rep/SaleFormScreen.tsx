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
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { COLORS, formatMoneyEnIN, FRAME, ICON, RADII, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { Button, CalendarGrid, ConfirmDialog, DatePicker, SectionHeader, Select, Sheet, haptic, TextField } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
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

/** How far back a sale's date may reach. Not today: a rep often files the
 * sale the morning after, and no sale predates the product. */
export const SALE_HISTORY_FLOOR = '2020-01-01';

/** One line, as the form holds it: the snapshot taken at add time. */
export interface SaleFormLine {
  key: string;
  productId: string | null;
  productName: string;
  productSku: string | null;
  quantity: string;
  /** The owner's list price snapshot. The invoice's discount comes off this. */
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
      unitPrice?: string;
      listPrice?: string;
      discountPct?: string;
      serialNumbers?: string[];
    }>;
  }) => Promise<{ id: string }>;
  confirmSale: (id: string) => Promise<unknown>;
  /** Reachability. Drafts and confirms are server writes that run
   * directly today — offline both submits are disabled and say so. */
  online: boolean;
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
const DISCOUNT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

export function isValidQuantity(raw: string): boolean {
  const n = Number(raw);
  return QUANTITY_PATTERN.test(raw) && n > 0;
}

export function isValidUnitPrice(raw: string): boolean {
  return MONEY_PATTERN.test(raw);
}

/** '' means no discount; otherwise a percent between 0 and 100. */
export function isValidDiscount(raw: string): boolean {
  if (raw === '') return true;
  if (!DISCOUNT_PATTERN.test(raw)) return false;
  return Number(raw) <= 100;
}

/** The unit price after the rep's discount off list, rounded to paise —
 * the price the server stores. The rep never types a unit price. */
export function discountedUnitPriceOf(listPrice: string, discountPct: string): string {
  if (!isValidUnitPrice(listPrice) || !isValidDiscount(discountPct) || discountPct === '') return listPrice;
  // Exact integer paise, half-up — the server's arithmetic (sales service,
  // migration 019), so the price shown while typing is the price stored.
  const hundredths = (value: string): bigint => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole!) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  };
  const paise = (hundredths(listPrice) * (10000n - hundredths(discountPct)) + 5000n) / 10000n;
  return `${paise / 100n}.${(paise % 100n).toString().padStart(2, '0')}`;
}

/** A line is complete when its product, quantity and price are real. */
export function lineComplete(line: SaleFormLine): boolean {
  return (
    (line.productId !== null || line.productName.trim() !== '') &&
    isValidQuantity(line.quantity) &&
    isValidUnitPrice(line.unitPrice)
  );
}

/**
 * What the invoice comes to after its discount (2026-09-18): the discount is
 * one figure for the whole sale, not a line-by-line negotiation, so each line
 * is priced at `list × (1 − d)` and the totals are summed — the same
 * arithmetic the server runs per line (migration 019) and therefore the same
 * figure it will store.
 */
export function invoiceTotalOf(lines: readonly SaleFormLine[], discountPct: string): string {
  return sumMoney(
    lines.map((line) => lineTotalOf(line.quantity, discountedUnitPriceOf(line.unitPrice, discountPct))),
  );
}

/** The invoice's own discount: '' or '0' is none, and 100% is the ceiling. */
export function isValidInvoiceDiscount(discountPct: string): boolean {
  return isValidDiscount(discountPct);
}

/** The whole form can go to the wire when the company and every line are. */
export function formComplete(
  companyId: string | null,
  lines: readonly SaleFormLine[],
  discountPct = '',
): boolean {
  return (
    companyId !== null &&
    lines.length > 0 &&
    lines.every(lineComplete) &&
    isValidInvoiceDiscount(discountPct)
  );
}

/** The wire items — each line sends its list price and THE INVOICE'S
 * discount, and the server computes and stores the unit price beside them
 * (migration 019). One discount for the sale is carried as the same
 * percentage on every line: the sums are identical, and the owner's
 * per-line reads stay meaningful. */
export function itemsOf(lines: readonly SaleFormLine[], discountPct = ''): Array<{
  productId?: string;
  productName: string;
  productSku?: string;
  quantity: number;
  unitPrice?: string;
  listPrice?: string;
  discountPct?: string;
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
      listPrice: line.unitPrice,
      discountPct: discountPct === '' ? '0' : discountPct,
      ...(serials.length > 0 ? { serialNumbers: serials } : {}),
    };
  });
}

export function SaleFormScreen(deps: SaleFormDeps): React.ReactNode {
  const [companyId, setCompanyId] = useState<string | null>(deps.initialCompanyId ?? null);
  const [saleDate, setSaleDate] = useState(deps.today);
  // The day picker (2026-09-18): `DatePicker` is a field with a trigger and
  // no choosing UI of its own — its tap re-emits the date it holds, so a
  // sale's date could be read but never moved. This opens the app's month
  // calendar instead, floored far back: a rep often files a sale the day
  // after he made it.
  const [pickingDate, setPickingDate] = useState(false);
  const [lines, setLines] = useState<SaleFormLine[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const companyName = useMemo(
    () => deps.companies.find((c) => c.id === companyId)?.name ?? null,
    [companyId, deps.companies],
  );

  const companyOptions = useMemo(
    () => deps.companies.map((c) => ({ value: c.id, label: c.name })),
    [deps.companies],
  );
  const productOptions = useMemo(
    () => deps.products.map((p) => ({ value: p.id, label: `${p.name} · ${p.sku}`, caption: `₹${formatMoneyEnIN(p.defaultPrice)}` })),
    [deps.products],
  );

  /** One discount for the whole sale (Yashas, 2026-09-18): the discount is
   * negotiated on the invoice, not product by product. Each line is priced
   * at list x (1 - d) and the totals are summed — the server's own
   * arithmetic, so the figure here is the figure stored. */
  const [invoiceDiscount, setInvoiceDiscount] = useState('');
  const subtotal = useMemo(
    () => sumMoney(lines.map((l) => lineTotalOf(l.quantity, l.unitPrice))),
    [lines],
  );
  const total = useMemo(() => invoiceTotalOf(lines, invoiceDiscount), [lines, invoiceDiscount]);
  const complete = formComplete(companyId, lines, invoiceDiscount);

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
        items: itemsOf(lines, invoiceDiscount),
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID={deps.testID ?? 'sale-form'}>
      {/* The navy frame: what is being raised. */}
      <View style={styles.frame}>
        <Text style={styles.frameTitle} testID="sale-form-title">
          New sale
        </Text>
        <Text style={styles.frameCaption}>A sale, its lines and its serials.</Text>
      </View>

      {error !== null ? (
        <Text style={styles.errorText} testID="sale-form-error">
          {error}
        </Text>
      ) : null}

      <View style={styles.sectionWrap}>
        <SectionHeader label="Company" icon="business" />
      </View>
      <View style={styles.block}>
        {/* A dropdown, not a list of every account under the field (Yashas,
            2026-09-18): the app's own `Select`, searchable, with the chosen
            account named on the field. */}
        <Select
          label="Company"
          value={companyId}
          options={companyOptions}
          placeholder="Search his accounts and house"
          onSelect={(value: string) => setCompanyId(value)}
          testID="sale-form-company"
        />
      </View>

      <View style={styles.sectionWrap}>
        <SectionHeader label="Date" icon="calendar" />
      </View>
      <View style={styles.block}>
        <DatePicker label="Date" value={saleDate} onChange={() => setPickingDate(true)} testID="sale-form-date" />
      </View>

      <View style={styles.sectionWrap}>
        <SectionHeader label="Line items" icon="cube" count={lines.length} />
      </View>
      {lines.map((line) => (
        <View key={line.key} style={styles.line} testID={`sale-form-line-${line.key}`}>
          <View style={styles.lineHead}>
            {/* The product's own mark, tinted like every other glyph chip:
                the line reads as an object, not as a run of text. */}
            <View style={styles.lineMark}>
              <Icon name="cube" size={ICON.sm} color={SEMANTIC.text.primary} />
            </View>
            <View style={styles.lineMain}>
              <Text style={styles.rowPrimary}>{line.productName}</Text>
              <Text style={styles.snapshot}>
                {`${line.productSku ?? ''} · list ₹${formatMoneyEnIN(line.unitPrice)}`}
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
              <TextField
                label="Unit price"
                value={line.unitPrice}
                onChangeText={(t) => patchLine(line.key, { unitPrice: t })}
                testID={`sale-form-line-price-${line.key}`}
              />
            </View>
          </View>
          {/* The line comes to quantity × its price; the sale's discount is
              applied once, on the invoice below. */}
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

      {/* The same dropdown shape for the product: choosing one ADDS a line,
          so the field is a door, not a value — it keeps its placeholder. */}
      <Select
        label="Add a product"
        value={null}
        options={productOptions}
        placeholder="Search products by name or SKU"
        onSelect={(value: string) => {
          const picked = deps.products.find((p) => p.id === value);
          if (picked !== undefined) addProduct(picked);
        }}
        testID="sale-form-product"
      />

      {/* The invoice's own arithmetic: what the lines come to, the discount
          negotiated for the sale, and the figure that follows. */}
      <View style={styles.invoicePanel} testID="sale-form-invoice">
        <View style={styles.invoiceRow}>
          <Text style={styles.invoiceLabel}>Subtotal</Text>
          <Text style={styles.invoiceValue} testID="sale-form-subtotal">
            {`₹${formatMoneyEnIN(subtotal)}`}
          </Text>
        </View>
        <View style={styles.discountRow}>
          <View style={styles.discountCell}>
            <TextField
              label="Discount for this sale (%)"
              value={invoiceDiscount}
              onChangeText={setInvoiceDiscount}
              placeholder="0"
              errorText={isValidInvoiceDiscount(invoiceDiscount) ? undefined : 'A discount is 0 to 100.'}
              testID="sale-form-discount"
            />
          </View>
          <Text style={styles.discountNote}>
            {invoiceDiscount === '' || invoiceDiscount === '0'
              ? 'Nothing off'
              : `${invoiceDiscount}% off every line`}
          </Text>
        </View>
        <View style={styles.totalRow} testID="sale-form-total">
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{`₹${formatMoneyEnIN(total)}`}</Text>
        </View>
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
          disabled={!complete || !deps.online}
          disabledReason={
            !deps.online
              ? "You're offline — saving needs a connection."
              : 'Pick the company and add at least one complete line.'
          }
          fullwidth
          testID="sale-form-save-draft"
        />
        <Button
          label="Confirm sale"
          onPress={() => {
            haptic('primaryActionPress');
            setConfirming(true);
          }}
          disabled={!complete || !deps.online}
          disabledReason={
            !deps.online
              ? "You're offline — confirming needs a connection."
              : 'Pick the company and add at least one complete line.'
          }
          fullwidth
          testID="sale-form-confirm"
        />
      </View>

      {pickingDate ? (
        <Sheet visible title="Which day" onDismiss={() => setPickingDate(false)} testID="sale-form-date-sheet">
          <CalendarGrid
            value={saleDate}
            todayIso={deps.today}
            minIso={SALE_HISTORY_FLOOR}
            onSelect={(iso) => {
              haptic('pickerSelect');
              setSaleDate(iso);
              setPickingDate(false);
            }}
            testID="sale-form-date-calendar"
          />
        </Sheet>
      ) : null}

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
  /** The page's own ground on the scroll itself, under the frame. */
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  content: {
    paddingBottom: SPACE[8],
    paddingTop: SPACE[2],
    paddingHorizontal: SPACE[4],
    gap: SPACE[3],
  },
  /** The navy frame: what is being raised. */
  frame: {
    backgroundColor: FRAME.bg,
    marginTop: SPACE[2] * -1,
    marginHorizontal: SPACE[4] * -1,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[4],
    paddingBottom: SPACE[4],
    gap: 2,
  },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  /** Every marker sits inside the page's gutters, not on its edge. */
  sectionWrap: { marginTop: SPACE[5] },
  block: {
    gap: SPACE[2],
  },
  /** "Add a product" is an instruction, not a field label. */
  addLabel: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  /** The product's glyph chip on a line. */
  lineMark: {
    width: 28,
    height: 28,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.pressed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The invoice's arithmetic, on the raised ground with the accent rail. */
  invoicePanel: {
    marginTop: SPACE[4],
    padding: SPACE[3],
    gap: SPACE[3],
    borderWidth: 1,
    borderLeftWidth: 4,
    borderColor: SEMANTIC.line.default,
    borderLeftColor: COLORS.accent,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  invoiceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE[3] },
  invoiceLabel: { ...textStyle('body'), color: SEMANTIC.text.secondary },
  invoiceValue: { ...textStyle('mono'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
  discountRow: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE[3] },
  discountCell: { width: 160 },
  discountNote: { ...textStyle('caption'), color: SEMANTIC.text.secondary, flex: 1, paddingBottom: 6 },
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
    gap: SPACE[3],
    minHeight: TAP.min,
    paddingHorizontal: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  /** A pickable row: bordered, so it reads as a thing to press. */
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: TAP.min,
    paddingHorizontal: SPACE[3],
    marginTop: SPACE[2],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    gap: SPACE[3],
  },
  line: {
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
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
