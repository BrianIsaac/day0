import { dark } from '@clerk/themes';
import { describe, expect, it } from 'vitest';
import { clerkAppearance } from '../../app/clerk-appearance';

/** The names Clerk's Core 2 read and Core 3 ignores, which left the hosted widget unreadable. */
const RETIRED_VARIABLES = [
  'colorText',
  'colorTextSecondary',
  'colorTextOnPrimaryBackground',
  'colorInputBackground',
  'colorInputText',
  'colorAlphaShade',
];

describe('the Clerk appearance', () => {
  it("builds on Clerk's dark theme, so every surface it does not name is dark too", () => {
    expect(clerkAppearance.theme).toBe(dark);
  });

  it('names no variable Clerk 7 no longer reads', () => {
    for (const name of RETIRED_VARIABLES)
      expect(clerkAppearance.variables).not.toHaveProperty(name);
  });

  it("gives the widget's text, muted text, inputs and primary button the product's tokens", () => {
    expect(clerkAppearance.variables).toMatchObject({
      colorBackground: '#18181b',
      colorForeground: '#f4f4f5',
      colorMutedForeground: '#a1a1aa',
      colorInput: '#0a0a0b',
      colorInputForeground: '#f4f4f5',
      colorPrimary: '#22d3ee',
      colorPrimaryForeground: '#0a0a0b',
      colorDanger: '#ef4444',
      colorSuccess: '#34d399',
      colorWarning: '#f59e0b',
    });
  });

  it('keeps the neutral light, as a dark theme must for its borders and hovers to show', () => {
    expect(clerkAppearance.variables.colorNeutral).toBe('#f4f4f5');
  });
});
