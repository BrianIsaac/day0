import { describe, expect, it } from 'vitest';
import { companyHandSteps, loadBedSpec } from '../../../scripts/bed/spec';

describe('the company bed hand steps', (): void => {
  it('asks for the Slack asks during each sitting, after the employees are deployed, never left standing beforehand', (): void => {
    const slack = companyHandSteps(loadBedSpec(process.cwd())).find((line) =>
      line.startsWith('2. Slack'),
    );
    expect(slack).toContain('posted by you during each sitting, once the employees are deployed');
    expect(slack).not.toContain('left standing');
  });
});
