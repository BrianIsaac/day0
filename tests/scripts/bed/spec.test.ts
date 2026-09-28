import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { companyHandSteps, loadBedSpec } from '../../../scripts/bed/spec';

/** The repository root, found from this file rather than the working directory. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('the company bed hand steps', (): void => {
  it('asks for the Slack asks during each sitting, after the employees are deployed, never left standing beforehand', (): void => {
    const slack = companyHandSteps(loadBedSpec(ROOT)).find((line) => line.startsWith('2. Slack'));
    expect(slack).toContain('posted by you during each sitting, once the employees are deployed');
    expect(slack).not.toContain('left standing');
  });
});
