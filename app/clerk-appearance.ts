import type { Appearance } from '@clerk/ui';
import { dark } from '@clerk/themes';

/**
 * How every Clerk surface looks: the sign-in and sign-up pages, the header's sign-in and
 * create-account modals, and the account menu.
 *
 * Clerk's dark theme (`@clerk/themes`) is the base, so anything the variables do not name is
 * still dark, and the product's tokens (`app/globals.css`) are laid over it under the names Clerk
 * 7 reads. The names Core 2 read (`colorText`, `colorInputBackground`, `colorInputText`) are
 * ignored by Core 3 without a warning, which is how the widget's title, labels, divider and footer
 * came to be drawn dark on dark. `@clerk/ui`, installed for its types only, types every
 * `appearance` prop and `satisfies Appearance` here, so the typecheck refuses a name Clerk does
 * not read.
 */
export const clerkAppearance = {
  theme: dark,
  variables: {
    colorBackground: '#18181b',
    colorForeground: '#f4f4f5',
    colorMutedForeground: '#a1a1aa',
    colorMuted: '#101012',
    colorNeutral: '#f4f4f5',
    colorBorder: '#3f3f46',
    colorInput: '#0a0a0b',
    colorInputForeground: '#f4f4f5',
    colorPrimary: '#22d3ee',
    colorPrimaryForeground: '#0a0a0b',
    colorRing: '#22d3ee',
    colorDanger: '#ef4444',
    colorSuccess: '#34d399',
    colorWarning: '#f59e0b',
    colorModalBackdrop: '#0a0a0b',
    colorShadow: '#000000',
    borderRadius: '0.5rem',
  },
} satisfies Appearance;
