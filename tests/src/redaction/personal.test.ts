import { describe, expect, it } from 'vitest';
import { personalDataSpans, type PersonalKind } from '../../../src/redaction/personal';

/** What the grammar found, as the text it covers and its kind. */
function found(text: string): Array<[string, PersonalKind]> {
  return personalDataSpans(text).map((span) => [text.slice(span.start, span.end), span.kind]);
}

describe('personalDataSpans', (): void => {
  it('finds an e-mail address wherever it sits', (): void => {
    expect(found('cc jane.doe@acme.com on the reply')).toEqual([['jane.doe@acme.com', 'email']]);
    expect(found('<ops+close@finance.example.co.uk>')).toEqual([
      ['ops+close@finance.example.co.uk', 'email'],
    ]);
  });

  it('finds a phone number written with its country code or after a phone label', (): void => {
    expect(found('call +65 9123 4567 after six')).toEqual([['+65 9123 4567', 'phone']]);
    expect(found('US desk +1 (415) 555-0100')).toEqual([['+1 (415) 555-0100', 'phone']]);
    expect(found('Tel: 6123 4567')).toEqual([['6123 4567', 'phone']]);
    expect(found('Mobile number: 9123-4567')).toEqual([['9123-4567', 'phone']]);
    expect(found('手机：13800138000')).toEqual([['13800138000', 'phone']]);
  });

  it('finds a date only after a birth label', (): void => {
    expect(found('Date of birth: 12 March 1990')).toEqual([['12 March 1990', 'date-of-birth']]);
    expect(found('DOB 1990-03-12')).toEqual([['1990-03-12', 'date-of-birth']]);
    expect(found('born on March 12, 1990')).toEqual([['March 12, 1990', 'date-of-birth']]);
    expect(found('出生日期：1990年3月12日')).toEqual([['1990年3月12日', 'date-of-birth']]);
  });

  it('finds the rest of the line after an address label, and not an e-mail, IP or endpoint address', (): void => {
    expect(found('Home address: 10 Anson Road, #20-01, Singapore 079903\nnext')).toEqual([
      ['10 Anson Road, #20-01, Singapore 079903', 'address'],
    ]);
    expect(found('- Address: 1 Raffles Place')).toEqual([['1 Raffles Place', 'address']]);
    expect(found('地址：北京市朝阳区建国路88号')).toEqual([['北京市朝阳区建国路88号', 'address']]);
    expect(found('The IP address: 10.0.0.4 answers')).toEqual([]);
    expect(found('Endpoint address: https://api.example.test/v1')).toEqual([]);
  });

  it('leaves a bare number, a bare date and an id alone, as a ledger is full of them', (): void => {
    for (const text of [
      'Pipeline coverage 1,234,567 for Q3',
      'ts 1790551800.123456',
      'due 2026-09-30',
      'REVOPS-12345678',
      'order 91234567',
      'phone the vendor about invoice 12',
    ]) {
      expect(found(text), text).toEqual([]);
    }
  });
});
