/**
 * Pure helpers for the D4 Customer screens (T2.10, UI/plan-2/05-DISPATCHER.md
 * §D4) — the seam the screens render over and the tests assert against,
 * with no react-native import (the same split T2.8's `jobLogsFilters.ts`
 * and T2.9's `dispatchForm.ts` use): the form fields, the create/edit
 * bodies, and submit-time validation.
 *
 * The two absences the spec states hardest live here so they cannot drift
 * in the JSX:
 *
 * - **No company field.** `CustomerFormFields` does not carry a
 *   `companyId`, so neither the create body nor the patch body can even
 *   express one — the server strips it a second time
 *   (`DispatcherCustomerCreateSchema` / `dispatcherCustomerPatchSchema`,
 *   PLAN.md §5 rule 3), but a dispatcher form that offers the field has
 *   already lost; the type is the first gate.
 * - **The stack is read-only here.** Nothing in this module edits a
 *   stack item — the capability is not merely hidden, it does not exist
 *   on the dispatcher's form path.
 */

/** One field of the customer form — create and edit share it. The type
 * is deliberately closed: a `Company` field would be a compile error
 * away from shipping, and the server strips it regardless (§5 rule 3). */
export interface CustomerFormFields {
  name: string;
  phone: string;
  altPhone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  pincode: string;
  notes: string;
}

/** A blank form — every field empty, nothing prefilled. */
export function emptyCustomerForm(): CustomerFormFields {
  return { name: '', phone: '', altPhone: '', addressLine1: '', addressLine2: '', city: '', pincode: '', notes: '' };
}

/** The form as the site's current record holds it — the edit mode's
 * starting point. The detail type is `CustomerDetailDispatcher`, which
 * has no `companyId` to copy: the omission is type-level. */
export function customerFormOf(detail: {
  name: string;
  phone: string;
  altPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  notes: string | null;
}): CustomerFormFields {
  return {
    name: detail.name,
    phone: detail.phone,
    altPhone: detail.altPhone ?? '',
    addressLine1: detail.addressLine1 ?? '',
    addressLine2: detail.addressLine2 ?? '',
    city: detail.city ?? '',
    pincode: detail.pincode ?? '',
    notes: detail.notes ?? '',
  };
}

/** `''` → `undefined` — an empty field is an absent one on create; the
 * server's optional strings prefer absence to empty strings. */
function orUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** `''` → `null` — on PATCH an emptied field CLEARS the stored one;
 * the api's patch columns are `nullish` on purpose. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The POST /v1/customers body for a dispatcher. The shape has no
 * `companyId` — the shared `DispatcherCustomerCreateSchema` would strip
 * one anyway, and its `.strict()` would refuse anything else unexpected.
 */
export interface DispatcherCustomerCreateBody {
  name: string;
  phone: string;
  altPhone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  pincode?: string;
  notes?: string;
}

/** The create body — name and phone are required by the form's own
 * validation before this is ever called. */
export function customerCreateBody(fields: CustomerFormFields): DispatcherCustomerCreateBody {
  return {
    name: fields.name.trim(),
    phone: fields.phone.trim(),
    altPhone: orUndefined(fields.altPhone),
    addressLine1: orUndefined(fields.addressLine1),
    addressLine2: orUndefined(fields.addressLine2),
    city: orUndefined(fields.city),
    pincode: orUndefined(fields.pincode),
    notes: orUndefined(fields.notes),
  };
}

/**
 * The PATCH /v1/customers/:id body — ONLY the fields that changed
 * against the record the form opened with, `null` when a field was
 * emptied (a clear), `undefined` when untouched (absent). `null` when
 * nothing changed at all: the api refuses an empty patch ("Nothing to
 * change."), and the hook shows that sentence instead of a pointless
 * round trip.
 */
export interface DispatcherCustomerPatchBody {
  name?: string;
  phone?: string;
  altPhone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  pincode?: string | null;
  notes?: string | null;
}

export function customerPatchBody(before: CustomerFormFields, next: CustomerFormFields): DispatcherCustomerPatchBody | null {
  const body: DispatcherCustomerPatchBody = {};
  /** Changed-vs-before, `null` when emptied (a clear), absent when not. */
  const nullable = (key: 'altPhone' | 'addressLine1' | 'addressLine2' | 'city' | 'pincode' | 'notes'): void => {
    const value = orNull(next[key]);
    if (value !== before[key]) body[key] = value;
  };
  if (next.name.trim() !== before.name) body.name = next.name.trim();
  if (next.phone.trim() !== before.phone) body.phone = next.phone.trim();
  nullable('altPhone');
  nullable('addressLine1');
  nullable('addressLine2');
  nullable('city');
  nullable('pincode');
  nullable('notes');
  return Object.keys(body).length === 0 ? null : body;
}

/** Which field the submit refused, worded for the dispatcher on the
 * phone (03-COMPONENTS.md: validate on submit, never while typing). */
export interface CustomerFormProblems {
  name?: string;
  phone?: string;
}

/** The two things a site record cannot exist without: a name and a
 * phone — the dispatcher is taking them down mid-call. */
export function validateCustomerForm(fields: CustomerFormFields): CustomerFormProblems {
  const problems: CustomerFormProblems = {};
  if (fields.name.trim() === '') problems.name = 'Who is the site? A name is required.';
  if (fields.phone.trim() === '') problems.phone = 'A phone number is required.';
  return problems;
}
