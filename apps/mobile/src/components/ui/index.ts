/**
 * UI primitives barrel (T0.12) — the eleven, each specified in all
 * seven states (03-COMPONENTS.md). Screens import from here; the
 * gallery (`app/_dev/gallery.tsx`) renders every component × state ×
 * density so `error` and `empty` cannot be reinvented per screen.
 */
export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { TextField, type TextFieldProps } from './TextField';
export { MoneyField, type MoneyFieldProps } from './MoneyField';
export { Select, type SelectProps, type SelectOption } from './Select';
export { DatePicker, formatDateEnIN, formatDateWithYear, type DatePickerProps } from './DatePicker';
export { CalendarGrid, type CalendarGridProps } from './CalendarGrid';
export { Sheet, type SheetProps } from './Sheet';
export { Banner, type BannerProps, type BannerTone } from './Banner';
export { Skeleton, type SkeletonProps } from './Skeleton';
export { Chip, type ChipProps } from './Chip';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { SectionHeader, type SectionHeaderProps } from './SectionHeader';
export { Icon, type IconName, type IconProps } from './icons';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
export {
  DeskListShell,
  PageHeader,
  Panel,
  PanelRow,
  pageContentStyle,
  type PageHeaderProps,
  type PanelProps,
  type DeskListShellProps,
} from './desk';
export { DensityProvider, useDensity, useDensityMetrics } from './DensityProvider';
export { haptic } from './haptics';
export { captionStyle, labelStyle, tapTargetForDensity } from './uiBase';
export { textStyle, resolveFontFamily } from '../../fonts/textStyle';
