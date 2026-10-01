import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ReportingElsewhere,
  type ReportingElsewhereEmployee,
} from '../../../app/home/ReportingElsewhere';

/** One employee as `agents.employeesReportingElsewhere` names it. */
function employee(agentId: string, name: string): ReportingElsewhereEmployee {
  return { agentId: agentId as ReportingElsewhereEmployee['agentId'], name };
}

/** The line as a manager reads it, tags stripped. */
const readAs = (markup: string): string =>
  markup
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

describe('ReportingElsewhere (the home line, D17)', () => {
  it('names the one employee as a link to its People tab and says to choose there', () => {
    const html = renderToStaticMarkup(
      <ReportingElsewhere employees={[employee('agent-maya', 'Maya')]} />,
    );
    expect(readAs(html)).toBe(
      '1 employee reports to someone who is not you: Maya. Choose on its People tab.',
    );
    expect(html).toContain('href="/agent/agent-maya/people"');
  });

  it('names several in a list, each a link', () => {
    const html = renderToStaticMarkup(
      <ReportingElsewhere
        employees={[
          employee('agent-maya', 'Maya'),
          employee('agent-tomas', 'Tomas'),
          employee('agent-aiko', 'Aiko'),
        ]}
      />,
    );
    expect(readAs(html)).toBe(
      "3 employees report to someone who is not you: Maya, Tomas and Aiko. Choose on each one's People tab.",
    );
    expect(html.match(/<a /g)).toHaveLength(3);
  });

  it('draws nothing when no employee reports elsewhere', () => {
    expect(renderToStaticMarkup(<ReportingElsewhere employees={[]} />)).toBe('');
  });
});
