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

  it('leaves a signed amount with its currency and a signed date alone, which only look like a country code', (): void => {
    for (const text of [
      'variance +1.234.567 EUR',
      'moved +12 345 678 SGD this week',
      'margin +1 234 567% on plan',
      'shifted +2026-09-28',
    ]) {
      expect(found(text), text).toEqual([]);
    }
  });

  it('finds a phone however its country writes it, and a signed number with nothing beside it', (): void => {
    for (const phone of [
      '+6591234567',
      '+44 20 7946 0958',
      '+34 612 345 678',
      '+351 912 345 678',
      '+48 123 456 789',
      '+420 601 123 456',
      '+34.612.345.678',
      '+447911 123456',
      '+6012-3456789',
      '+65 9123 4567 SMS',
    ]) {
      const [span] = found(`reach me on ${phone}`);
      expect(span, phone).toEqual([phone.replace(/ SMS$/, ''), 'phone']);
    }
    // Nothing marks it a figure, and a missed phone leaves the export.
    expect(found('moved +12 345 678 this week')).toEqual([['+12 345 678', 'phone']]);
  });

  it('finds the labelled forms the export floor claims: bold labels, 号 and 号码, a dotted D.O.B., two more date shapes, a non-ASCII e-mail and a mid-line Address (wave 3.5 review M22)', (): void => {
    const cases: Array<[string, string, PersonalKind]> = [
      ['**Phone:** 9123 4567', '9123 4567', 'phone'],
      ['*Phone:* 9123 4567', '9123 4567', 'phone'],
      ['Tel. 6123 4567', '6123 4567', 'phone'],
      ['手机号：13800138000', '13800138000', 'phone'],
      ['电话号码：138 0013 8000', '138 0013 8000', 'phone'],
      ['**DOB:** 12/03/1990', '12/03/1990', 'date-of-birth'],
      ['D.O.B.: 12/03/1990', '12/03/1990', 'date-of-birth'],
      ['DOB: 1990/03/12', '1990/03/12', 'date-of-birth'],
      ['DOB: 12-Mar-1990', '12-Mar-1990', 'date-of-birth'],
      ['Birth date: 12/03/1990', '12/03/1990', 'date-of-birth'],
      ['出生年月日：1990年3月12日', '1990年3月12日', 'date-of-birth'],
      ['**Address:** 1 Raffles Place', '1 Raffles Place', 'address'],
      ['Name: Jane Tan, Address: 1 Raffles Place', '1 Raffles Place', 'address'],
      ['reach jane@bücher.de first', 'jane@bücher.de', 'email'],
      ['reach 张三@example.com first', '张三@example.com', 'email'],
    ];
    for (const [text, value, kind] of cases) {
      expect(found(text), text).toEqual([[value, kind]]);
    }
  });

  it('leaves working data a label happens to sit beside: a date on a phone line, a host name or a URL with a note on an address line', (): void => {
    for (const text of [
      'phone 2026-09-28',
      'Address: api.linear.app',
      'Address: localhost:8080',
      'Address: https://mcp.linear.app/mcp (prod)',
    ]) {
      expect(found(text), text).toEqual([]);
    }
  });

  it('leaves an endpoint, an e-mail or an IP on a bare Address line to its own rules', (): void => {
    expect(found('Address: https://mcp.linear.app/mcp')).toEqual([]);
    expect(found('- Address: 10.0.0.4:8080')).toEqual([]);
    expect(found('Address: ops@finance.example')).toEqual([['ops@finance.example', 'email']]);
  });
});
