'use client';

import { useId, type FormEvent } from 'react';
import type { CredentialPresentation } from '@/surfaces/credential-presentation';
import { Button } from '../../../components/Button';
import { INPUT_CLASS } from '../../../components/Field';
import type { ExpectedCredential } from './card-words';

/** The credential field's inputs: what the card says of the credential, and the landing. */
export interface CredentialFieldProps {
  /** Whose credential the field takes, and what happens to it (Q10). */
  readonly expected: ExpectedCredential;
  /** Whether the card is approved: nothing is landed on a card nobody agreed to (B D6). */
  readonly approved: boolean;
  /**
   * Whether an active organisation connection covers the card's system: its access then comes
   * from that connection, never from a paste (the access plan, section 4.3), so no field is drawn.
   */
  readonly covered?: boolean;
  readonly error?: string;
  readonly landing: boolean;
  readonly onLand: (plaintext: string) => void;
  readonly presentation: CredentialPresentation;
  /** What the store says of the stored credential, when it is not simply live. */
  readonly status?: string;
}

/**
 * A card's credential: what is stored or documented, what the store says of it, and, once the
 * card is approved, a write-only field labelled with whose credential it takes. Before approval
 * the card says what it will ask for instead of offering a field the server refuses (B D6). Where
 * an organisation connection covers the system there is no field at all: the card connects
 * through it (section 4.3).
 *
 * The field is uncontrolled: the value goes from the form to the action and never lands in React
 * state, where a devtools snapshot or an error boundary could keep it.
 */
export function CredentialField(props: CredentialFieldProps) {
  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const value = new FormData(form).get('credential');
    form.reset();
    if (typeof value === 'string' && value.trim()) props.onLand(value);
  }

  // One id, whatever the credential is called: an id list splits on spaces. The prefix is what the
  // rehearsal driver finds the field by (`input[id^="credential-"]`).
  const fieldId = `credential-${useId()}`;
  const { presentation } = props;
  const takesPaste = presentation.canLand && props.covered !== true;
  return (
    <div className="grid gap-2 text-sm">
      <p className="text-[var(--color-fg-2)]">
        {presentation.label ? `${presentation.label}: ` : ''}
        {presentation.text}
      </p>
      {presentation.kind === 'oauth' && presentation.detail ? (
        <p className="text-[13px] text-[var(--color-muted)]">
          OAuth approval procedure: {presentation.detail}
        </p>
      ) : null}
      {props.status ? <p className="text-[var(--color-warn)]">Status: {props.status}</p> : null}
      {presentation.governanceFinding ? (
        <p className="text-[var(--color-warn)]">{presentation.governanceFinding}</p>
      ) : null}
      {takesPaste && !props.approved ? (
        <p className="text-[13px] text-[var(--color-muted)]">
          Once you approve, the card asks for {lowerFirst(props.expected.label)}.
        </p>
      ) : null}
      {takesPaste && props.approved && presentation.landingNote ? (
        <p className="text-[13px] text-[var(--color-muted)]">{presentation.landingNote}</p>
      ) : null}
      {takesPaste && props.approved ? (
        <form onSubmit={onSubmit} className="grid gap-1.5">
          <label htmlFor={fieldId} className="text-[13px] font-medium text-[var(--color-fg-2)]">
            {props.expected.label}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={fieldId}
              name="credential"
              type="password"
              autoComplete="new-password"
              required
              aria-describedby={`${fieldId}-hint`}
              className={`${INPUT_CLASS} min-w-48 flex-1`}
            />
            <Button type="submit" size="small" disabled={props.landing}>
              {props.landing ? 'Landing…' : (presentation.landingLabel ?? 'Land credential')}
            </Button>
          </div>
          <p id={`${fieldId}-hint`} className="text-[13px] text-[var(--color-muted)]">
            {props.expected.hint}
          </p>
        </form>
      ) : null}
      {props.error ? (
        <p role="alert" className="text-[var(--color-danger)]">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** A sentence's first letter in lower case, for a label quoted inside another sentence. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
