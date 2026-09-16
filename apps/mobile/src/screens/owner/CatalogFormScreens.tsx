/**
 * Adding to the catalogue (OW.3, 2026-09-16) — the owner asked for a way
 * to add a product and a service, which the console had no door for at
 * all: `POST /v1/products` and `POST /v1/services` have existed since
 * Phase 0 (owner-only, §6.4) and nothing on screen could reach them.
 *
 * Both forms are pure over props, like every other screen: the route owns
 * the write. Validation is on submit, never while typing
 * (03-COMPONENTS.md), and the server's sentence is what a refusal shows.
 */
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { LAYOUT, SEMANTIC, SPACE } from '@servgrid/shared';
import {
  Banner,
  Button,
  MoneyField,
  PageHeader,
  Panel,
  Select,
  TextField,
  pageContentStyle,
  useDensity,
} from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';

/** The catalogue's five categories (PLAN-DATA-MODEL.md §3.2). */
const CATEGORY_OPTIONS = [
  { value: 'ups', label: 'UPS' },
  { value: 'battery', label: 'Battery' },
  { value: 'inverter', label: 'Inverter' },
  { value: 'accessory', label: 'Accessory' },
  { value: 'spare', label: 'Spare' },
];

export interface ProductDraft {
  sku: string;
  name: string;
  category: string;
  brand: string;
  modelNumber: string;
  capacityLabel: string;
  unit: string;
  defaultPrice: string;
  warrantyMonths: string;
}

export function emptyProductDraft(): ProductDraft {
  return {
    sku: '',
    name: '',
    category: 'ups',
    brand: '',
    modelNumber: '',
    capacityLabel: '',
    unit: '',
    defaultPrice: '',
    warrantyMonths: '',
  };
}

export type ProductProblems = Partial<Record<'sku' | 'name' | 'defaultPrice' | 'warrantyMonths', string>>;

/** A price and a warranty are optional; when typed they have to be a number. */
export function validateProduct(draft: ProductDraft): ProductProblems {
  const problems: ProductProblems = {};
  if (draft.sku.trim() === '') problems.sku = 'A product needs an SKU — the code your team will search by.';
  if (draft.name.trim() === '') problems.name = 'What is it called?';
  if (draft.defaultPrice.trim() !== '' && !/^\d+(\.\d{1,2})?$/.test(draft.defaultPrice.trim())) {
    problems.defaultPrice = 'A price like 8400 or 8400.50, or leave it empty.';
  }
  const months = draft.warrantyMonths.trim();
  if (months !== '' && !/^\d{1,4}$/.test(months)) {
    problems.warrantyMonths = 'Warranty in whole months, for example 24.';
  }
  return problems;
}

/** Only what was filled in crosses the wire — the schema is strict and an empty string is not an absent field. */
export function productPayload(draft: ProductDraft): Record<string, unknown> {
  const text = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());
  const months = draft.warrantyMonths.trim();
  return {
    sku: draft.sku.trim(),
    name: draft.name.trim(),
    category: draft.category,
    ...(text(draft.brand) === undefined ? {} : { brand: text(draft.brand) }),
    ...(text(draft.modelNumber) === undefined ? {} : { modelNumber: text(draft.modelNumber) }),
    ...(text(draft.capacityLabel) === undefined ? {} : { capacityLabel: text(draft.capacityLabel) }),
    ...(text(draft.unit) === undefined ? {} : { unit: text(draft.unit) }),
    ...(text(draft.defaultPrice) === undefined ? {} : { defaultPrice: draft.defaultPrice.trim() }),
    ...(months === '' ? {} : { warrantyMonths: Number(months) }),
  };
}

export interface ServiceDraft {
  code: string;
  name: string;
  description: string;
  defaultCharge: string;
}

export function emptyServiceDraft(): ServiceDraft {
  return { code: '', name: '', description: '', defaultCharge: '' };
}

export type ServiceProblems = Partial<Record<'code' | 'name' | 'defaultCharge', string>>;

export function validateService(draft: ServiceDraft): ServiceProblems {
  const problems: ServiceProblems = {};
  if (draft.code.trim() === '') problems.code = 'A service needs a code — AMC, INSTALL, BATT-SWAP.';
  if (draft.name.trim() === '') problems.name = 'What is this job type called?';
  if (draft.defaultCharge.trim() !== '' && !/^\d+(\.\d{1,2})?$/.test(draft.defaultCharge.trim())) {
    problems.defaultCharge = 'A charge like 1500 or 1500.50, or leave it empty.';
  }
  return problems;
}

export function servicePayload(draft: ServiceDraft): Record<string, unknown> {
  const description = draft.description.trim();
  const charge = draft.defaultCharge.trim();
  return {
    code: draft.code.trim().toUpperCase(),
    name: draft.name.trim(),
    ...(description === '' ? {} : { description }),
    ...(charge === '' ? {} : { defaultCharge: charge }),
  };
}

function FormFrame({
  title,
  subtitle,
  children,
  error,
  onCancel,
  onSubmit,
  submitLabel,
  busy,
  testID,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  testID: string;
}): React.ReactNode {
  const desk = useDensity() === 'desk';
  return (
    <ScrollView
      testID={testID}
      style={{ flex: 1, backgroundColor: desk ? 'transparent' : SEMANTIC.bg.app }}
      contentContainerStyle={pageContentStyle(desk)}
    >
      <PageHeader title={title} subtitle={subtitle} testID={`${testID}-header`} />
      <View style={{ maxWidth: desk ? LAYOUT.contentMaxWidth : undefined, width: '100%' }}>
        <Panel>
          {error === null ? null : <Banner tone="danger" message={error} testID={`${testID}-error`} />}
          <View style={{ gap: SPACE[4], marginTop: error === null ? 0 : SPACE[3] }}>{children}</View>
          <View style={{ flexDirection: 'row', gap: SPACE[3], marginTop: SPACE[5] }}>
            <Button label={submitLabel} onPress={onSubmit} loading={busy} testID={`${testID}-submit`} />
            <Button label="Cancel" variant="secondary" onPress={onCancel} testID={`${testID}-cancel`} />
          </View>
        </Panel>
      </View>
    </ScrollView>
  );
}

export interface ProductFormScreenProps {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}

export function OwnerProductFormScreen(props: ProductFormScreenProps): React.ReactNode {
  const [draft, setDraft] = useState<ProductDraft>(emptyProductDraft);
  const [problems, setProblems] = useState<ProductProblems>({});
  const set = (patch: Partial<ProductDraft>): void => setDraft((current) => ({ ...current, ...patch }));

  return (
    <FormFrame
      title="New product"
      subtitle="The catalogue a technician picks parts from and a rep sells."
      error={props.error}
      busy={props.busy}
      submitLabel="Add product"
      onCancel={props.onCancel}
      onSubmit={() => {
        const found = validateProduct(draft);
        setProblems(found);
        if (Object.keys(found).length > 0) return;
        props.onSubmit(productPayload(draft));
      }}
      testID="owner-product-form"
    >
      <TextField
        label="SKU"
        value={draft.sku}
        onChangeText={(sku) => set({ sku })}
        errorText={problems.sku}
        helperText="The code the team searches by — UPS-APC-BX1100."
        testID="product-sku"
      />
      <TextField
        label="Name"
        value={draft.name}
        onChangeText={(name) => set({ name })}
        errorText={problems.name}
        testID="product-name"
      />
      <Select
        label="Category"
        value={draft.category}
        options={CATEGORY_OPTIONS}
        onSelect={(category) => set({ category })}
        helperText="Decides whether a fitted unit joins the site's equipment by default."
        testID="product-category"
      />
      <TextField label="Brand" value={draft.brand} onChangeText={(brand) => set({ brand })} testID="product-brand" />
      <TextField
        label="Model number"
        value={draft.modelNumber}
        onChangeText={(modelNumber) => set({ modelNumber })}
        testID="product-model"
      />
      <TextField
        label="Capacity"
        value={draft.capacityLabel}
        onChangeText={(capacityLabel) => set({ capacityLabel })}
        helperText="850VA, 150Ah — what the customer asks for."
        testID="product-capacity"
      />
      <TextField label="Unit" value={draft.unit} onChangeText={(unit) => set({ unit })} testID="product-unit" />
      <MoneyField
        label="Default price"
        value={draft.defaultPrice}
        onChangeText={(defaultPrice) => set({ defaultPrice })}
        errorText={problems.defaultPrice}
        helperText="Optional — a rep can still price a line himself."
        testID="product-price"
      />
      <TextField
        label="Warranty (months)"
        value={draft.warrantyMonths}
        onChangeText={(warrantyMonths) => set({ warrantyMonths })}
        errorText={problems.warrantyMonths}
        testID="product-warranty"
      />
    </FormFrame>
  );
}

export interface ServiceFormScreenProps {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}

export function OwnerServiceFormScreen(props: ServiceFormScreenProps): React.ReactNode {
  const [draft, setDraft] = useState<ServiceDraft>(emptyServiceDraft);
  const [problems, setProblems] = useState<ServiceProblems>({});
  const set = (patch: Partial<ServiceDraft>): void => setDraft((current) => ({ ...current, ...patch }));

  return (
    <FormFrame
      title="New service"
      subtitle="The job types a dispatcher picks from when raising work."
      error={props.error}
      busy={props.busy}
      submitLabel="Add service"
      onCancel={props.onCancel}
      onSubmit={() => {
        const found = validateService(draft);
        setProblems(found);
        if (Object.keys(found).length > 0) return;
        props.onSubmit(servicePayload(draft));
      }}
      testID="owner-service-form"
    >
      <TextField
        label="Code"
        value={draft.code}
        onChangeText={(code) => set({ code })}
        errorText={problems.code}
        helperText="Short and shouted: AMC, INSTALL, BATT-SWAP."
        testID="service-code"
      />
      <TextField
        label="Name"
        value={draft.name}
        onChangeText={(name) => set({ name })}
        errorText={problems.name}
        testID="service-name"
      />
      <TextField
        label="Description"
        value={draft.description}
        onChangeText={(description) => set({ description })}
        multiline
        rows={3}
        testID="service-description"
      />
      <MoneyField
        label="Default charge"
        value={draft.defaultCharge}
        onChangeText={(defaultCharge) => set({ defaultCharge })}
        errorText={problems.defaultCharge}
        helperText="Optional — the technician still enters what was collected."
        testID="service-charge"
      />
      <Text style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary }}>
        A service is never deleted; deactivate it and it leaves the pickers while its history stands.
      </Text>
    </FormFrame>
  );
}
