import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useEmployee } from '../../../../app/agent/[agentId]/employee-context';
import { asEmployee } from '../../../fixtures/dom/employee';

function Name() {
  return <p>{useEmployee().agent.name}</p>;
}

describe('useEmployee', () => {
  it('reads the employee the shell loaded', () => {
    expect(renderToStaticMarkup(asEmployee(<Name />))).toBe('<p>Mira</p>');
  });

  it('refuses to be read outside the employee page', () => {
    expect(() => renderToStaticMarkup(<Name />)).toThrow('inside the employee page only');
  });
});
