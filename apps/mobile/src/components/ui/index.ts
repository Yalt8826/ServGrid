/**
 * UI primitives barrel (T0.12) — the eleven, each specified in all
 * eight states (03-COMPONENTS.md). Screens import from here; the
 * gallery (`app/_dev/gallery.tsx`) renders every component × state ×
 * density so `stale` and `error` cannot be reinvented per screen.
 */
export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { TextField, type TextFieldProps } from './TextField';
export { MoneyField, type MoneyFieldProps } from './MoneyField';
export { Select, type SelectProps, type SelectOption } from './Select';
export { DatePicker, formatDateEnIN, type DatePickerProps } from './DatePicker';
export { Sheet, type SheetProps } from './Sheet';
export { Banner, type BannerProps, type BannerTone } from './Banner';
export { Skeleton, type SkeletonProps } from './Skeleton';
export { Chip, type ChipProps } from './Chip';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
export { DensityProvider, useDensity, useDensityMetrics } from './DensityProvider';
export { haptic } from './haptics';
export { captionStyle, staleInsetStyle, labelStyle, tapTargetForDensity } from './uiBase';
export { textStyle, resolveFontFamily } from '../../fonts/textStyle';
