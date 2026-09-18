import { describe, expect, it } from 'vitest';
import { BED_PROFILES } from '../../scripts/demo-bed';
import { bedComposeFlags, trialConfiguration } from '../../scripts/eval-revocation';

describe('what the revocation trial records about the stack it ran on', (): void => {
  it('names the redactor the demo-bed kit starts', (): void => {
    expect(trialConfiguration('day0-demo-7c65e7').profiles).toContain('redactor');
  });

  it('takes the profiles from the kit rather than keeping a second list', (): void => {
    expect(trialConfiguration('day0-demo-7c65e7').profiles).toEqual([...BED_PROFILES]);
  });

  it('records the compose project the trial was pointed at', (): void => {
    expect(trialConfiguration('day0-p11-a').composeProject).toBe('day0-p11-a');
  });

  it('still records the rest of the stack the trial is measured against', (): void => {
    expect(trialConfiguration('day0-demo-7c65e7')).toMatchObject({
      surfaceMode: 'real',
      folderDocumentation: 'docs-local/ mounted read-only at /docs',
      fakeProviders: ['fake-slack', 'looker-tile'],
      daytonaBlanked: true,
      onboardingTranscriptPath: 'evaluation/onboarding/day0.json',
    });
  });
});

describe('the commands the evidence tells a reader to repeat', (): void => {
  it('brings up every component the recorded stack names', (): void => {
    const flags = bedComposeFlags();
    for (const profile of trialConfiguration('day0-demo-7c65e7').profiles) {
      if (profile === 'real') continue;
      expect(flags).toContain(`--profile ${profile}`);
    }
    expect(flags).toContain('--profile redactor');
  });

  it('leaves out the base profile, which every compose invocation adds', (): void => {
    expect(bedComposeFlags()).not.toContain('--profile real');
  });
});
