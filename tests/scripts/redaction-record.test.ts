import { describe, expect, it } from 'vitest';
import { recordingAddress } from '../../scripts/redaction-record';

describe('the redactor address a recording dials', (): void => {
  it('takes an address this machine can reach', (): void => {
    expect(recordingAddress({ DAY0_REDACTOR_URL: 'http://127.0.0.1:8765' })).toEqual({
      url: 'http://127.0.0.1:8765',
    });
    expect(recordingAddress({ DAY0_REDACTOR_URL: 'http://172.20.0.4:8000' })).toEqual({
      url: 'http://172.20.0.4:8000',
    });
  });

  it("refuses the backend container's own address, which this machine cannot resolve, and says how to reach it", (): void => {
    const answer = recordingAddress({ DAY0_REDACTOR_URL: 'http://redactor:8000' });
    expect('refusal' in answer && answer.refusal).toContain(
      'DAY0_REDACTOR_URL is http://redactor:8000, which is the address the backend container uses',
    );
    expect('refusal' in answer && answer.refusal).toContain('publishes no host port');
    expect('refusal' in answer && answer.refusal).toContain('ps -q redactor');
  });

  it('refuses an unset address with the same way in', (): void => {
    const answer = recordingAddress({});
    expect('refusal' in answer && answer.refusal).toContain('DAY0_REDACTOR_URL is unset');
    expect('refusal' in answer && answer.refusal).toContain('pnpm redactor:up');
    expect('refusal' in answer && answer.refusal).toContain('ps -q redactor');
  });
});
