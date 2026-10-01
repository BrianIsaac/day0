import type { Appearance } from '@clerk/ui';
import { dark } from '@clerk/themes';

/** Day0's mark drawn for Clerk's dark card (`public/day0-mark.svg`), served from the app itself. */
export const DAY0_MARK_URL = '/day0-mark.svg';

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
 *
 * Day0's mark is set here rather than in Clerk's dashboard, so the deployment's code decides it
 * (the operator's ask, 30 September). Inside the card, Clerk draws it only on a card that asks for
 * a logo; the account menu's popover and profile ask for none, and the sign-in and sign-up flows
 * draw it outside (`clerkSignInAppearance`).
 */
export const clerkAppearance = {
  theme: dark,
  options: {
    logoImageUrl: DAY0_MARK_URL,
    logoPlacement: 'inside',
    // The mark leads home within the product, never to the Clerk instance's configured home.
    logoLinkUrl: '/',
  },
  variables: {
    colorBackground: '#18181b',
    colorForeground: '#f4f4f5',
    colorMutedForeground: '#a1a1aa',
    // The neutral is what Clerk derives its borders, dividers and hovers from, at its own
    // alphas; a fixed border colour read as no border at all on the card (29 September shots).
    colorNeutral: '#f4f4f5',
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

/**
 * How the sign-in and sign-up flows look: the shared appearance, with Day0's mark above the card
 * on every step.
 *
 * Inside the card the mark reached only the steps whose card asks Clerk for a logo. Clerk's
 * code-entry card (`VerificationCodeCard` in `@clerk/ui` 1.36: "Check your email", "Verify your
 * email", a second factor's code) never does, so those steps had none (the v0.11.0 walk).
 * Outside is the one placement Clerk draws on every card of a flow. It is kept to the two flows:
 * the account menu's popover and profile are cards too, and a mark above them would float over
 * the header. Clerk spaces an outside mark from the card on small screens only; the margin keeps
 * that space at every width.
 */
export const clerkSignInAppearance = {
  ...clerkAppearance,
  options: { ...clerkAppearance.options, logoPlacement: 'outside' },
  elements: { logoBox: { marginBottom: '1.75rem' } },
} satisfies Appearance;

/**
 * The appearance of a Clerk widget drawn under a page's own h1: the sign-in and sign-up pages.
 *
 * Clerk draws every step's title as an h1, so on the first step, where the page's heading already
 * says what the card is for, the card's header, its title and subtitle, is left out: the mark
 * above the card and the form inside it are all the step shows (the hosted walk's m26). Later
 * steps keep their headers: they say what to do ("Check your email") and to which address, and
 * the page's heading steps down to a paragraph there (`StepHeading`), so each step has one h1.
 * All of it goes through Clerk's own element styles, never a stylesheet selector on its classes,
 * which Clerk reports as structural CSS on every page.
 *
 * @param firstStep - Whether the widget is on its first step (`HeadedClerk.tsx` reads it off the
 *   path, by which Clerk routes its steps).
 */
export function headedClerkAppearance(firstStep: boolean): Appearance {
  if (!firstStep) return clerkSignInAppearance;
  return {
    ...clerkSignInAppearance,
    elements: { ...clerkSignInAppearance.elements, header: { display: 'none' } },
  };
}
