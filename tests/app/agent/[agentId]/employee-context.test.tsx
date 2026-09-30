import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useEmployee } from '../../../../app/agent/[agentId]/employee-context';
import type { Id } from '../../../../convex/_generated/dataModel';
import { asEmployee } from '../../../fixtures/dom/employee';

function Name() {
  return <p>{useEmployee().agent.name}</p>;
}

describe('useEmployee', () => {
  it('reads the employee the shell loaded', () => {
    expect(renderToStaticMarkup(asEmployee(<Name />))).toBe('<p>Mira</p>');
  });

  it('carries the Skills tab’s last authoring verdict and the way to file one, as the shell holds them (review m8)', () => {
    const file = (): void => undefined;
    function Attempt() {
      const { lastAttempt, setLastAttempt } = useEmployee();
      const kept = lastAttempt ? `${lastAttempt.name}: ${lastAttempt.reason}` : 'none';
      return (
        <p>{`${kept}; ${setLastAttempt === file ? 'the shell’s setter' : 'another setter'}`}</p>
      );
    }
    expect(
      renderToStaticMarkup(
        asEmployee(<Attempt />, {
          lastAttempt: {
            skillId: 'skill-1' as Id<'skills'>,
            name: 'refresh-the-tile',
            reason: 'authoring did not finish',
          },
          setLastAttempt: file,
        }),
      ),
    ).toBe('<p>refresh-the-tile: authoring did not finish; the shell’s setter</p>');
    expect(renderToStaticMarkup(asEmployee(<Attempt />))).toBe('<p>none; another setter</p>');
  });

  it('refuses to be read outside the employee page', () => {
    expect(() => renderToStaticMarkup(<Name />)).toThrow('inside the employee page only');
  });
});
