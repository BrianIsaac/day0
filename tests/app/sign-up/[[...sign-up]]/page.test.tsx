import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs', () => ({ SignUp: (): null => null }));

import SignUpPage from '../../../../app/sign-up/[[...sign-up]]/page';

describe('the sign-up page', (): void => {
  it('asks for an account under its own heading', (): void => {
    expect(renderToStaticMarkup(<SignUpPage />)).toContain('Create an account');
  });

  it('leaves the one main landmark to the layout', (): void => {
    expect(renderToStaticMarkup(<SignUpPage />)).not.toMatch(/<main[\s>]/);
  });
});
