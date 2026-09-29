import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import EmployeeLayout from '../../../../app/agent/[agentId]/layout';
import { EmployeeShell } from '../../../../app/agent/[agentId]/EmployeeShell';

describe('the employee page layout', () => {
  it("puts the open tab's page inside the shell of the employee the route names", async () => {
    const child = <p>tab</p>;
    const element = await EmployeeLayout({
      children: child,
      params: Promise.resolve({ agentId: 'j57agent' }),
    });
    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe(EmployeeShell);
    expect(element.props).toEqual({ agentId: 'j57agent', children: child });
  });
});
