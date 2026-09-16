/**
 * T4 Complete sheet (T1.19, UI/plan-2/04-TECHNICIAN.md §T4,
 * PLAN-FRONTEND.md §9). The highest-stakes screen in the product —
 * filled one-handed, in poor light, possibly gloved, by someone who
 * wants to leave, sometimes at 8% battery.
 *
 * **One screen. No wizard. No page two.** Order exactly as §T4: Work
 * done → Amount collected → + Add discount → Paid by → Parts &
 * equipment / Photos → Customer confirmed the work → submit.
 *
 * The decisions that shape this file (every one argued in §T4):
 *
 * - **`MoneyGate action="create"`** wraps the amount and the Paid-by
 *   segments. The action prop is required and spelled here — a gate
 *   defaulting to `read` would hide the amount field from the
 *   technician filling it in, whose `job.money` read scope is `none`.
 * - **AMC job — two segments above the money: Free under AMC (where the
 *   sheet opens) and Charge (decision 9, 2026-09-15).** On Free the
 *   amount field, the discount disclosure and the Paid-by segments are
 *   ABSENT — not zero, not disabled, not in the tree — and nothing is
 *   collected. Charge brings the ordinary money fields back for extra
 *   work the customer pays for. The two segment controls are built
 *   exactly like the Paid-by ones: same props, same styles, same haptic.
 * - **No charge → "No payment taken"** in the segments' place, a single
 *   non-interactive line; `collection_mode: 'none'` is submitted. A
 *   warranty job is never asked how he was paid for work that was free.
 * - **In-warranty unit with a charge** — ONE confirmation on submit,
 *   a prompt, not a block, and the only dialog on this sheet.
 * - **Parts & equipment is one list, not two**, one extra question per
 *   line ("Add to this site's equipment"), defaulted from the product's
 *   category. One list, two server arrays — see `completeSheet.ts`.
 * - **Never a subtotal.** The parts list sits below the amount and
 *   changes no figure; the derived after-discount amount is never
 *   rendered.
 * - **Submit is never disabled for a network reason** — `submitBlockerOf`
 *   has no network-shaped input to read; a lost connection is the
 *   no-connection gate's to show. Submit goes to `loading` while the
 *   server files it, the Success haptic fires when the server has it —
 *   delivery, not intent — and a failure keeps the sheet open with
 *   everything typed and the reason on a banner.
 * - **The context strip** — the sheet leaves ~140pt of the job detail
 *   above it, so the header AND the StatusStepper stay visible: the
 *   technician can see which job he is completing (03-COMPONENTS.md
 *   `Sheet`: 64pt is the minimum, the stepper is the number that
 *   matters).
 * - **Photos are never required.** The section counts what is attached
 *   (none, until the attachment capture task lands) and says the rule
 *   aloud rather than blocking on it.
 *
 * Pure UI over injected seams — the route owns the write to the server
 * (`POST /v1/jobs/:id/complete`) and its idempotency key.
 */
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { alpha, COLORS, ICON, RADII, SEMANTIC, SPACE, stripToNumeric, TAP, TINT } from '@servgrid/shared';
import type { Role } from '@servgrid/shared';
import { MoneyGate } from '../../components/domain/MoneyGate';
import { Banner } from '../../components/ui/Banner';
import { Button } from '../../components/ui/Button';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { Icon } from '../../components/ui/icons';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { MoneyField } from '../../components/ui/MoneyField';
import { Select } from '../../components/ui/Select';
import { Sheet } from '../../components/ui/Sheet';
import { TextField } from '../../components/ui/TextField';
import { haptic } from '../../components/ui/haptics';
import { textStyle } from '../../fonts/textStyle';
import { messageOfWriteError } from '../../lib/intentWrite';
import type { JobView } from './jobView';
import { detailContractChipOf } from './jobDetail';
import {
  chargeApplies,
  inWarranty,
  partLineOf,
  payloadOf,
  submitBlockerOf,
  warrantyConfirmMessageOf,
  AMC_SEGMENTS,
  DEFAULT_AMC_CHOICE,
  isAmcJob,
  isFreeUnderAmc,
  PAYMENT_SEGMENTS,
  type AmcChoice,
  type CollectionMode,
  type CompleteSheetPayload,
  type PartLine,
  type PartProduct,
} from './completeSheet';

/** What must stay visible above the sheet: the docket header AND the
 * StatusStepper (~140pt; 03-COMPONENTS.md `Sheet`). */
export const CONTEXT_STRIP_PT = 140;
/** The Sheet component carries the 64pt minimum itself; this is the rest. */
export const CONTEXT_STRIP_EXTRA_PT = CONTEXT_STRIP_PT - 64;

export interface CompleteSheetDeps {
  /** The job being completed — status, contract, the unit (warranty). */
  view: JobView;
  /** The product catalogue for the parts picker, from the work read. */
  products: readonly PartProduct[];
  /**
   * The service catalogue (2026-09-16). The sheet's first question is which
   * service was done, and the answer sets the cost: `services.default_charge`
   * is where a price comes from, so nobody in the field invents one.
   */
  services: readonly ServiceOption[];
  /**
   * The camera and the library, and the upload that files what they return
   * — dep seams, like the rep's `captureProof`, so this sheet renders and
   * is testable without a device. Optional: a sheet with no picker wired
   * shows the section's rule and no buttons rather than a dead one.
   */
  takePhoto?: () => Promise<string | null>;
  choosePhoto?: () => Promise<string | null>;
  uploadPhoto?: (fileUri: string) => Promise<{ id: string }>;
  /** The session actor's role — the MoneyGate reads it. */
  role: Role;
  /** Injectable clock — the warranty chip and the stack's installed-on. */
  now: Date;
  /**
   * Files the completion with the server (the route's). Resolves once the
   * server has it; rejects with the sentence to show when it does not —
   * and the sheet stays open with everything typed (PLAN-FRONTEND.md §5).
   */
  onSubmit: (payload: CompleteSheetPayload) => Promise<void>;
  onDismiss: () => void;
}

/** One catalogue row the sheet offers: what the work was, and what it costs. */
export interface ServiceOption {
  id: string;
  name: string;
  /** The catalogue's charge as a money string, or null when it has none. */
  defaultCharge: string | null;
}

/** One photo taken or chosen on this visit: the row it was filed as, and
 * the local file the thumbnail renders from. */
interface TakenPhoto {
  id: string;
  uri: string;
}

type PickerMode = 'closed' | 'catalogue';

export function CompleteSheet(deps: CompleteSheetDeps): React.ReactNode {
  const { view } = deps;

  // Decision 9: an AMC job's sheet OPENS on Free under AMC; the
  // technician switches to Charge when the visit carries extra work.
  const amcJob = isAmcJob(view);
  const [amcChoice, setAmcChoice] = useState<AmcChoice>(DEFAULT_AMC_CHOICE);

  // The service is the sheet's first answer, and the cost follows from it.
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [photos, setPhotos] = useState<TakenPhoto[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<Exclude<CollectionMode, 'bank_transfer' | 'none'>>('cash');
  const [partsOpen, setPartsOpen] = useState(false);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [lines, setLines] = useState<PartLine[]>([]);
  const [picker, setPicker] = useState<PickerMode>('closed');
  const [customerConfirmed, setCustomerConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Pinned on the first attempt: a retry under the same idempotency key
  // must carry the same body, or the server refuses it as a different request.
  const [completedAtPin, setCompletedAtPin] = useState<string | null>(null);
  const [warrantyDialog, setWarrantyDialog] = useState(false);
  // Confirmed once this session — the prompt is a reminder, not a toll
  // (§T4: exactly one confirmation, never two dialogs a day).
  const [warrantyAcked, setWarrantyAcked] = useState(false);

  // Free under AMC: the money inputs are fed to the blocker as empty —
  // NOT skipped — so a half-typed discount left behind on the Charge side
  // can never block a free completion (§T4 blockers are validation facts
  // about what will be SENT, and a free visit sends nothing).
  const free = isFreeUnderAmc(view, amcChoice);
  const chosenService = serviceId === null ? null : (deps.services.find((s) => s.id === serviceId) ?? null);
  // Narrowed once so the guards below cannot be defeated by a re-render.
  const take = deps.takePhoto;
  const choose = deps.choosePhoto;
  const upload = deps.uploadPhoto;
  const blocker = submitBlockerOf({
    serviceId,
    amount: free ? '' : amount,
    lines,
  });
  const charged = !free && chargeApplies(amount, '');
  const warranty = inWarranty(view, deps.now);

  /**
   * Take or choose a photo, then file it against the job card.
   *
   * Filed immediately rather than held until submit: the card exists, the
   * photo is evidence the moment it is taken, and a technician who loses
   * signal between the shutter and the submit has still filed his picture.
   * The card is the "before" side of the split migration 008 documents,
   * which is where a photo taken while the work is being closed belongs
   * until the completion row exists to own it.
   *
   * A refusal is a sentence in the section, never a blocked submit: the
   * section's own rule is that a photo is never required.
   */
  async function addPhoto(
    source: () => Promise<string | null>,
    upload: (fileUri: string) => Promise<{ id: string }>,
  ): Promise<void> {
    if (photoBusy) return;
    setPhotoError(null);
    setPhotoBusy(true);
    try {
      const fileUri = await source();
      if (fileUri === null) return; // he backed out — not an error
      const filed = await upload(fileUri);
      setPhotos((current) => [...current, { id: filed.id, uri: fileUri }]);
      setPhotosOpen(true);
      haptic('pickerSelect');
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : 'The photo could not be filed.');
    } finally {
      setPhotoBusy(false);
    }
  }

  function patchLine(localId: string, patch: Partial<PartLine>): void {
    setLines((current) => current.map((line) => (line.localId === localId ? { ...line, ...patch } : line)));
  }

  /** The submit pipeline past validation: send → the server accepts →
   * the Success haptic (delivery, never intent) → dismiss. A failure keeps
   * the sheet open with everything typed and says why. */
  function performSubmit(): void {
    if (blocker !== null || submitting) return;
    const completedAt = completedAtPin ?? new Date().toISOString();
    if (completedAtPin === null) setCompletedAtPin(completedAt);
    setSubmitting(true);
    setSubmitError(null);
    void (async () => {
      try {
        await deps.onSubmit(
          payloadOf({
            view,
            workSummary: chosenService?.name ?? '',
            serviceId: serviceId ?? '',
            amount,
            selectedMode,
            amcChoice,
            lines,
            customerConfirmed,
            now: deps.now,
            completedAt,
          }),
        );
        haptic('completionSynced');
        setSubmitting(false);
        deps.onDismiss();
      } catch (error) {
        setSubmitting(false);
        setSubmitError(messageOfWriteError(error));
      }
    })();
  }

  function onPressSubmit(): void {
    if (blocker !== null || submitting) return;
    // The sheet's only dialog: charging for in-warranty work. A prompt,
    // not a block — confirm and it files.
    if (charged && warranty && !warrantyAcked) {
      setWarrantyDialog(true);
      return;
    }
    performSubmit();
  }

  const hasUnsavedInput =
    serviceId !== null || amount !== '' || lines.length > 0 || photos.length > 0 || customerConfirmed;

  // The strip reserves room for the job's own header above the sheet, and
  // `flex: 1` bounds the sheet to the screen below it: this is the longest
  // form in the app, and its footer has to stay on screen (2026-09-16).
  return (
    <View testID="complete-context-strip" style={{ paddingTop: CONTEXT_STRIP_EXTRA_PT, flex: 1 }}>
      <Sheet
        visible
        testID="complete-sheet"
        title={`Complete ${view.job.jobNumber}`}
        hasUnsavedInput={hasUnsavedInput}
        onDismiss={deps.onDismiss}
        actions={
          <Button
            label="Complete job"
            onPress={onPressSubmit}
            loading={submitting}
            disabled={blocker !== null}
            disabledReason={blocker ?? undefined}
            fullwidth
            testID="complete-submit"
          />
        }
      >
        {/* Which service was done — the sheet's first question, and the
            one the cost follows from (2026-09-16, Yashas: "work done will
            have a dropdown menu and a list of services they can choose
            from and the cost is calculated from that"). It replaced a free
            text field: the office could read what he typed but could not
            count it, price it or reconcile it, and the price of a visit
            was whatever a technician in a stairwell decided to type.
            Choosing a service fills the amount from the catalogue's
            `default_charge` — and leaves it editable, because a visit
            sometimes needs something the catalogue did not foresee. */}
        <Select
          label="Service"
          value={serviceId ?? ''}
          options={deps.services.map((service) => ({
            value: service.id,
            label: service.name,
            ...(service.defaultCharge === null ? { caption: 'No price set' } : { caption: `₹ ${service.defaultCharge}` }),
          }))}
          placeholder="Which service did you do?"
          helperText="The amount below comes from the service's own charge."
          onSelect={(id) => {
            const service = deps.services.find((candidate) => candidate.id === id) ?? null;
            setServiceId(service?.id ?? null);
            // The catalogue's charge, or nothing to pre-fill — a service
            // without one leaves whatever he typed standing.
            if (service?.defaultCharge != null) setAmount(service.defaultCharge);
          }}
          testID="complete-service"
        />

        {/* The money half lives behind the gate whose action is spelled
            out — create, the write-once cell the technician holds. On an
            AMC job the Free/Charge segments sit above it (decision 9),
            built exactly like the Paid-by segments below. */}
        <MoneyGate role={deps.role} action="create" testID="complete-money-gate">
          {/* The money half is one section, marked like every other
              section in the app (2026-09-16). */}
          <View style={styles.block}>
            <SectionHeader label="Payment" icon="wallet" tint={COLORS.accent} />
          </View>
          {/* This visit — the AMC job's two segments. Free is where the
              sheet opens; Charge brings the money fields back. */}
          {amcJob ? (
            <View style={styles.block} testID="complete-amc-choice">
              <Text style={styles.subLabel}>This visit</Text>
              <View style={styles.segments}>
                {AMC_SEGMENTS.map((segment) => {
                  const selected = amcChoice === segment.choice;
                  return (
                    <Pressable
                      key={segment.choice}
                      testID={`complete-amc-${segment.choice}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => {
                        haptic('pickerSelect');
                        setAmcChoice(segment.choice);
                      }}
                      style={[styles.segment, selected ? styles.segmentSelected : null]}
                    >
                      <Text style={{ ...textStyle('label'), color: selected ? SEMANTIC.text.onDark : SEMANTIC.text.primary }}>
                        {segment.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {free ? (
            // Free under AMC — the money fields are ABSENT, not hidden:
            // a field in the tree is a field someone taps. The chip names
            // the AMC and the sentence says why nothing is collected.
            <View testID="complete-amc-free" style={styles.block}>
              <Text style={[styles.chip, styles.chipAccent]} testID="complete-amc-chip">
                {detailContractChipOf(view.job.contract)}
              </Text>
              {/* Nothing to collect is good news, so it is not a grey
                  sentence: the strip carries the tone and the tick. */}
              <View style={styles.successStrip}>
                <Icon name="checkFilled" size={ICON.sm} color={SEMANTIC.feedback.success} />
                <Text style={styles.successText}>Covered by the AMC — nothing is collected on this visit.</Text>
              </View>
            </View>
          ) : (
            <>
              <MoneyField
                label="Amount collected"
                value={amount}
                onChangeText={setAmount}
                helperText="Leave empty when nothing is charged."
                testID="complete-amount"
              />

              {/* Paid by — three segments, not five (§T4). Zero or empty
                  replaces them IN PLACE with the honest line. */}
              {charged ? (
                <View style={styles.block}>
                  <Text style={styles.subLabel}>Paid by</Text>
                  <View testID="complete-paid-by" style={styles.segments}>
                    {PAYMENT_SEGMENTS.map((segment) => {
                      const selected = selectedMode === segment.mode;
                      return (
                        <Pressable
                          key={segment.mode}
                          testID={`complete-segment-${segment.mode}`}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          onPress={() => {
                            haptic('pickerSelect');
                            setSelectedMode(segment.mode);
                          }}
                          style={[styles.segment, selected ? styles.segmentSelected : null]}
                        >
                          <Text style={{ ...textStyle('label'), color: selected ? SEMANTIC.text.onDark : SEMANTIC.text.primary }}>
                            {segment.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : (
                <View testID="complete-no-payment" style={styles.neutralStrip}>
                  <Icon name="info" size={ICON.sm} color={SEMANTIC.text.secondary} />
                  <Text style={styles.neutralText}>No payment taken</Text>
                </View>
              )}
            </>
          )}
        </MoneyGate>

        {/* Parts & equipment — ONE list, not two (§T4), below the
            amount, never a subtotal. */}
        <View style={styles.block}>
          <Pressable
            testID="complete-parts-toggle"
            accessibilityRole="button"
            onPress={() => {
              setPartsOpen(!partsOpen);
              setPicker('closed');
            }}
            style={styles.disclosure}
          >
            <SectionHeader
              label="Parts & equipment"
              icon="cube"
              count={lines.length}
              action={<Icon name={partsOpen ? 'chevronUp' : 'chevronDown'} size={ICON.sm} color={SEMANTIC.text.secondary} />}
            />
          </Pressable>

          {partsOpen ? (
            <View testID="complete-parts-list" style={styles.block}>
              {lines.map((line) => (
                <View key={line.localId} testID={`complete-line-${line.localId}`} style={styles.line}>
                  <View style={styles.lineHead}>
                    {line.productId === null ? (
                      <View style={{ flex: 1, marginRight: SPACE[2] }}>
                        <TextField
                          label="What is it?"
                          value={line.name}
                          onChangeText={(name) => patchLine(line.localId, { name })}
                          placeholder="Describe the item"
                          testID={`complete-line-${line.localId}-name`}
                        />
                      </View>
                    ) : (
                      <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 }}>{line.name}</Text>
                    )}
                    <Text style={styles.lineLabel}>qty</Text>
                    <TextInput
                      accessibilityLabel="Quantity"
                      testID={`complete-line-${line.localId}-qty`}
                      inputMode="decimal"
                      keyboardType="numeric"
                      value={line.quantity}
                      onChangeText={(t) => patchLine(line.localId, { quantity: stripToNumeric(t) })}
                      style={styles.qty}
                    />
                    <Pressable
                      testID={`complete-line-${line.localId}-remove`}
                      accessibilityRole="button"
                      accessibilityLabel="Remove line"
                      hitSlop={TAP.hitSlop}
                      onPress={() => setLines((current) => current.filter((candidate) => candidate.localId !== line.localId))}
                      style={styles.remove}
                    >
                      <Text style={{ ...textStyle('body'), color: SEMANTIC.text.secondary }}>✕</Text>
                    </Pressable>
                  </View>
                  <View style={styles.lineRow}>
                    <Text style={styles.lineLabel}>Serial</Text>
                    <TextInput
                      accessibilityLabel={`Serial for ${line.name}`}
                      testID={`complete-line-${line.localId}-serial`}
                      value={line.serial}
                      onChangeText={(serial) => patchLine(line.localId, { serial })}
                      placeholder={line.addToEquipment ? 'Required for the site’s equipment' : 'Optional'}
                      placeholderTextColor={SEMANTIC.text.placeholder}
                      style={styles.serial}
                    />
                  </View>
                  <Pressable
                    testID={`complete-line-${line.localId}-equipment`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: line.addToEquipment }}
                    onPress={() => {
                      haptic('pickerSelect');
                      patchLine(line.localId, { addToEquipment: !line.addToEquipment });
                    }}
                    style={styles.checkbox}
                  >
                    <Icon
                      name={line.addToEquipment ? 'checkFilled' : 'check'}
                      size={ICON.md}
                      color={line.addToEquipment ? SEMANTIC.feedback.success : SEMANTIC.text.placeholder}
                    />
                    <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 }}>Add to this site's equipment</Text>
                  </Pressable>
                </View>
              ))}

              {picker === 'closed' ? (
                <Button label="+ Add" variant="secondary" onPress={() => setPicker('catalogue')} testID="complete-part-add" />
              ) : (
                <View testID="complete-part-picker" style={styles.picker}>
                  {deps.products.map((product) => (
                    <Pressable
                      key={product.id}
                      testID={`complete-part-option-${product.id}`}
                      accessibilityRole="button"
                      onPress={() => {
                        haptic('pickerSelect');
                        setLines((current) => [...current, partLineOf(product, '')]);
                        setPicker('closed');
                      }}
                      style={styles.pickerRow}
                    >
                      <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 }}>{product.name}</Text>
                      <Text style={styles.lineLabel}>{product.category}</Text>
                    </Pressable>
                  ))}
                  <Pressable
                    testID="complete-part-option-freetext"
                    accessibilityRole="button"
                    onPress={() => {
                      haptic('pickerSelect');
                      setLines((current) => [...current, partLineOf(null, '')]);
                      setPicker('closed');
                    }}
                    style={styles.pickerRow}
                  >
                    <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>Describe it instead (free text)</Text>
                  </Pressable>
                  <Button label="Cancel" variant="ghost" onPress={() => setPicker('closed')} testID="complete-part-picker-close" />
                </View>
              )}
            </View>
          ) : null}
        </View>

        {/* Photos — collapsed, counted, and NEVER required (§T4 Never):
            a technician in a dark basement with a cracked camera still
            closes the job. The capture is real now (2026-09-16): the
            camera or the library, filed against the job card the moment
            it is taken, so the count on screen is a fact and not a
            promise. A failed upload says so and never blocks the submit. */}
        <View style={styles.block}>
          <Pressable
            testID="complete-photos-toggle"
            accessibilityRole="button"
            onPress={() => setPhotosOpen(!photosOpen)}
            style={styles.disclosure}
          >
            <SectionHeader
              label="Photos"
              icon="camera"
              count={photos.length}
              action={<Icon name={photosOpen ? 'chevronUp' : 'chevronDown'} size={ICON.sm} color={SEMANTIC.text.secondary} />}
            />
          </Pressable>
          {photosOpen ? (
            <View testID="complete-photos-empty" style={styles.photosEmpty}>
              {photos.length === 0 ? (
                <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>No photos attached.</Text>
              ) : (
                <View testID="complete-photos-grid" style={styles.photoGrid}>
                  {photos.map((photo) => (
                    <Image
                      key={photo.id}
                      source={{ uri: photo.uri }}
                      accessibilityLabel="Attached photo"
                      testID={`complete-photo-${photo.id}`}
                      style={styles.thumb}
                    />
                  ))}
                </View>
              )}
              {photoError === null ? null : (
                <Text testID="complete-photo-error" style={[styles.caption, { color: SEMANTIC.feedback.danger }]}>
                  {photoError}
                </Text>
              )}
              {take === undefined || upload === undefined ? null : (
                <View style={{ flexDirection: 'row', gap: SPACE[3], marginTop: SPACE[2] }}>
                  <View style={{ flex: 1 }}>
                    <Button
                      label="Take photo"
                      icon="camera"
                      variant="secondary"
                      fullwidth
                      loading={photoBusy}
                      onPress={() => void addPhoto(take, upload)}
                      testID="complete-photo-take"
                    />
                  </View>
                  {choose === undefined ? null : (
                    <View style={{ flex: 1 }}>
                      <Button
                        label="Attach"
                        icon="image"
                        variant="secondary"
                        fullwidth
                        disabled={photoBusy}
                        onPress={() => void addPhoto(choose, upload)}
                        testID="complete-photo-attach"
                      />
                    </View>
                  )}
                </View>
              )}
              <Text style={[styles.caption, { marginTop: SPACE[2] }]}>A photo is never required to close a job.</Text>
            </View>
          ) : null}
        </View>

        {/* Customer confirmed the work — the sheet's last question before
            the submit bar. */}
        <Pressable
          testID="complete-customer-confirmed"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: customerConfirmed }}
          onPress={() => {
            haptic('pickerSelect');
            setCustomerConfirmed(!customerConfirmed);
          }}
          style={[styles.confirmRow, customerConfirmed ? styles.confirmRowOn : null]}
        >
          <Icon
            name={customerConfirmed ? 'checkFilled' : 'check'}
            size={ICON.lg}
            color={customerConfirmed ? SEMANTIC.feedback.success : SEMANTIC.text.placeholder}
          />
          <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 }}>Customer confirmed the work</Text>
        </Pressable>

        {submitError !== null ? <Banner tone="danger" message={submitError} testID="complete-banner" /> : null}
      </Sheet>

      {/* The ONLY dialog on this sheet (§T4), which is what keeps it
          meaningful. In-warranty unit, a charge entered — asked once. */}
      <ConfirmDialog
        visible={warrantyDialog}
        title="Under warranty"
        message={warrantyConfirmMessageOf(view)}
        confirmLabel="Charge anyway"
        onCancel={() => setWarrantyDialog(false)}
        onConfirm={() => {
          setWarrantyDialog(false);
          setWarrantyAcked(true);
          performSubmit();
        }}
        testID="complete-warranty"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { alignSelf: 'stretch', gap: SPACE[3], marginTop: SPACE[5] },
  /** A label under a section marker (the marker names the section, this
   * names the control). */
  subLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  caption: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  /** A statement the sheet makes rather than a field it asks for: a tinted
   * strip with its glyph, so "nothing is collected" and "no payment taken"
   * are read as states instead of as small grey print. */
  successStrip: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    borderWidth: 1,
    borderColor: alpha(SEMANTIC.feedback.success, TINT.chipLine),
    backgroundColor: alpha(SEMANTIC.feedback.success, TINT.chip),
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
  },
  successText: { ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 },
  neutralStrip: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    // Floor, never ceiling: at 200% dynamic type the words wrap and the
    // strip grows (the §T4 Done-when rule for every touch row).
    minHeight: TAP.min,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: alpha(SEMANTIC.text.primary, TINT.wash),
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
  },
  neutralText: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary, flex: 1 },
  /** The last question before the submit bar, and the only one the
   * technician answers on the customer's behalf. */
  confirmRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    minHeight: TAP.min,
    marginTop: SPACE[5],
    paddingHorizontal: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
  },
  confirmRowOn: {
    borderColor: alpha(SEMANTIC.feedback.success, TINT.chipLine),
    backgroundColor: alpha(SEMANTIC.feedback.success, TINT.chip),
  },
  /** The contract chip, the same hairline box the detail screen wears —
   * on the accent, because it is the AMC's own colour there. */
  chip: {
    ...textStyle('label'),
    color: SEMANTIC.text.primary,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
    overflow: 'hidden',
  },
  chipAccent: {
    borderColor: alpha(COLORS.accent, TINT.chipLine),
    backgroundColor: alpha(COLORS.accent, TINT.chip),
  },
  segments: { flexDirection: 'row', gap: SPACE[2] },
  segment: {
    flex: 1,
    minHeight: TAP.min,
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACE[2],
  },
  segmentSelected: { backgroundColor: SEMANTIC.bg.dark, borderColor: SEMANTIC.bg.dark },
  noPayment: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.secondary,
    minHeight: TAP.min,
    textAlignVertical: 'center',
    marginTop: SPACE[4],
  },
  disclosure: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    minHeight: TAP.min,
  },
  line: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: alpha(SEMANTIC.text.primary, TINT.wash),
    padding: SPACE[3],
    gap: SPACE[3],
  },
  lineHead: { flexDirection: 'row', alignItems: 'center', minHeight: TAP.console },
  lineRow: { flexDirection: 'row', alignItems: 'center', minHeight: TAP.console, gap: SPACE[2] },
  lineLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  qty: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
    width: 56,
    minHeight: TAP.console,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    paddingHorizontal: 8,
    textAlignVertical: 'center',
  },
  serial: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    flex: 1,
    minHeight: TAP.console,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    paddingHorizontal: 8,
  },
  remove: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  checkbox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    minHeight: TAP.console,
    paddingVertical: SPACE[1],
  },
  picker: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    gap: SPACE[1],
    padding: SPACE[2],
  },
  pickerRow: {
    minHeight: TAP.min,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE[2],
    paddingHorizontal: SPACE[2],
  },
  photosEmpty: { alignSelf: 'stretch', gap: SPACE[1] },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.dense,
  },
});
