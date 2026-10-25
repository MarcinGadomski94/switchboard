/**
 * D131 · the v2 base components (`docs/v2.md` → *Components*). Import them from
 * here: `import { Button, StatusBadge } from '../components/index.ts'`.
 */
import './components.css';

export { Icon, ICON_NAMES, type IconName, type IconSize } from './Icon.tsx';
export { Button, IconButton, Kbd, type ButtonProps, type ButtonVariant, type IconButtonProps } from './Button.tsx';
export { Chip, StatusBadge } from './Chip.tsx';
export { Card, EmptyState, Skeleton } from './Card.tsx';
export { Segmented, Tabs, type SegmentOption, type TabItem } from './Tabs.tsx';
export { Menu, MenuButton, type MenuItem } from './Menu.tsx';
export { BottomSheet, Dialog, Drawer, Popover, Sheet } from './Overlays.tsx';
export { MAX_TOASTS, TOAST_MS, ToastProvider, useToast, type ToastInput } from './Toast.tsx';
export { Avatar, ComputerTag, colorFor, initials } from './Avatar.tsx';
export { Checkbox, Field, Select, Switch, TextArea, type SelectOption } from './Field.tsx';
export { focusables, useEscape, useFocusScope, useOutside } from './overlay.ts';
export { placeBelow } from './place.ts';
