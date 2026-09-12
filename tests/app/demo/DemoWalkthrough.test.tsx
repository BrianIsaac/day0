import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DemoWalkthrough } from '../../../app/demo/DemoWalkthrough';
import { HOSTED_DEMO_SNAPSHOT } from '../../../src/demo/hosted-demo-snapshot';

/**
 * The walkthrough is a recording served to strangers. Two properties matter more
 * than any piece of its copy: it must show what actually happened, and it must
 * not offer a control that looks like it would change anything.
 */
const html = renderToStaticMarkup(<DemoWalkthrough snapshot={HOSTED_DEMO_SNAPSHOT} />);

/** The same markup with entities resolved, so copy can be matched as it reads. */
const text = html
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

describe('what the walkthrough tells a visitor it is', (): void => {
  it('says it is a recording before it shows anything', (): void => {
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.recording.readOnly);
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.recording.sanitised);
  });

  it('offers no control that could be mistaken for an approval', (): void => {
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(text).not.toContain('Approve');
    expect(html).not.toContain('onclick');
  });

  it('explains the clock it is using instead of dates', (): void => {
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.recording.clock);
  });
});

describe('the charter and its approval', (): void => {
  it('shows the role the boss approved and when', (): void => {
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.charter.proposedFunction);
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.charter.whyThisHire);
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.charter.approvedAt);
    expect(text).toContain('approved');
  });

  it('shows the 30/60/90 goals and both sides of the boundary', (): void => {
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.charter.shortTermGoals.day30);
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.charter.proposedBoundaries.willDo[0]);
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.charter.proposedBoundaries.willNotDo[0]);
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.charter.proposedBoundaries.escalationTriggers[0]);
  });

  it('labels the published conversation evidence as sanitised summaries', (): void => {
    const evidence = HOSTED_DEMO_SNAPSHOT.charter.evidence[0];
    expect(text).toContain('sanitised summaries, not conversation quotations');
    expect(text).toContain(evidence.source);
    expect(text).toContain(evidence.text);
  });

  it('says the conversation itself is not part of the recording', (): void => {
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.conversation.note);
  });
});

describe('scope labels', (): void => {
  it('lists every scope the agent holds', (): void => {
    for (const scope of HOSTED_DEMO_SNAPSHOT.scopes) expect(text).toContain(scope.scope);
  });

  it('marks the scope that arrived with a skill approval, not with deployment', (): void => {
    const withSkill = HOSTED_DEMO_SNAPSHOT.scopes.filter((s) => s.grantedWithSkill);
    expect(withSkill.length).toBeGreaterThan(0);
    expect(text).toContain('granted with the skill');
  });
});

describe('the work', (): void => {
  it('shows every recorded item with its state and its source', (): void => {
    for (const item of HOSTED_DEMO_SNAPSHOT.workItems) {
      expect(text).toContain(item.title);
      expect(text).toContain(`${item.sourceSystem}/${item.sourceCategory}`);
      expect(text).toContain(item.contentSummary);
    }
  });

  it('shows the approved plan and every step of it', (): void => {
    const planned = HOSTED_DEMO_SNAPSHOT.workItems.filter((i) => i.plan);
    expect(planned.length).toBeGreaterThan(0);
    for (const item of planned) {
      expect(text).toContain(item.plan!.summary);
      for (const step of item.plan!.steps) expect(text).toContain(step);
      expect(text).toContain(item.plan!.riskNotes);
    }
  });

  it('shows what landed in the office, not only what the agent drafted', (): void => {
    const withOutput = HOSTED_DEMO_SNAPSHOT.workItems.filter((i) => i.output);
    for (const item of withOutput) {
      for (const action of item.output!.actions) expect(text).toContain(action.tool);
    }
  });

  it('shows the item the agent declined and why it declined it', (): void => {
    const skipped = HOSTED_DEMO_SNAPSHOT.workItems.find((i) => i.state === 'skipped');
    expect(skipped?.skipReason).toBeDefined();
    expect(text).toContain(skipped!.skipReason!);
  });
});

describe('the skill loop', (): void => {
  const authored = HOSTED_DEMO_SNAPSHOT.skills.find((s) => s.sourceType === 'agent-authored')!;

  it('shows the proposal, the scopes it asked for and its verification', (): void => {
    expect(text).toContain(authored.name);
    expect(text).toContain(authored.rationale!);
    for (const scope of authored.requiredScopes!) expect(text).toContain(scope);
    expect(text).toContain(authored.verificationLog!);
  });

  it('says the authored skill is not what the completed rows record', (): void => {
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.skillLoopNote);
  });

  it('marks the excerpted body as excerpted rather than passing it off as whole', (): void => {
    expect(authored.bodyExcerpted).toBe(true);
    expect(text).toContain('opening of');
  });
});

describe('the office and the sequence', (): void => {
  it('shows the surfaces the work was done against', (): void => {
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.office.spreadsheet.title);
    for (const channel of HOSTED_DEMO_SNAPSHOT.office.channels)
      expect(text).toContain(channel.displayName);
    for (const ticket of HOSTED_DEMO_SNAPSHOT.office.tickets) expect(text).toContain(ticket.title);
    for (const doc of HOSTED_DEMO_SNAPSHOT.office.docs) expect(text).toContain(doc.title);
    expect(text).toContain(HOSTED_DEMO_SNAPSHOT.office.socialMention.body);
  });

  it('shows the workspace the agent wrote for itself', (): void => {
    for (const file of HOSTED_DEMO_SNAPSHOT.workspace) {
      expect(text).toContain(file.fileName);
      expect(text).toContain(file.purpose);
    }
  });

  it('replays the whole sequence in order, with approval before action', (): void => {
    const approvedAt = text.indexOf('Charter approved by the boss');
    const firstPlanApproval = text.indexOf('Plan approved by the boss');
    const firstCompletion = text.indexOf('Work completed');
    expect(approvedAt).toBeGreaterThan(-1);
    expect(approvedAt).toBeLessThan(firstPlanApproval);
    expect(firstPlanApproval).toBeLessThan(firstCompletion);
  });

  it('gives every chapter an anchor a keyboard can reach', (): void => {
    for (const id of ['charter', 'scope', 'work', 'skills', 'workspace', 'office', 'sequence']) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
  });
});
