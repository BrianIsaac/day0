/** @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../../convex/onboarding';

describe('onboarding transcript parsing', (): void => {
  it('preserves labelled manager and agent ownership', (): void => {
    expect(
      parseTranscript(
        'ASSISTANT: Where does work live?\nUSER: Linear and Slack.\ncontinued detail',
      ),
    ).toEqual([
      { role: 'agent', text: 'Where does work live?' },
      { role: 'manager', text: 'Linear and Slack.\ncontinued detail' },
    ]);
  });

  it('drops text that has no preceding speaker', (): void => {
    expect(parseTranscript('unattributed\nUSER: owned answer')).toEqual([
      { role: 'manager', text: 'owned answer' },
    ]);
  });
});
