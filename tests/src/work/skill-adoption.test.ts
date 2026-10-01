import { describe, expect, it } from 'vitest';
import {
  adoptionCardState,
  adoptionFit,
  adoptionHelp,
  adoptionWords,
  chooseOffer,
  isOfferedTo,
  missingScopes,
  verifiedOnDay,
  type AdoptableVersion,
  type Adopter,
  type AdopterSurface,
} from '../../../src/work/skill-adoption';
import { HANDED_OVER_AUTHOR_NAME } from '../../../src/work/skill-library';

const LINEAR: AdopterSurface = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  connected: true,
  approvedTools: ['get_issue', 'save_comment', 'update_issue'],
  charterEvidence: true,
};

const SLACK: AdopterSurface = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  connected: true,
  approvedTools: ['chat.postMessage'],
  charterEvidence: false,
};

const MATEO: Adopter = {
  agentId: 'mateo',
  mode: 'real',
  surfaces: [LINEAR, SLACK],
  charterClasses: ['kanban'],
};

const VERSION: AdoptableVersion = {
  name: 'kanban-comment-and-close',
  surfaceClass: 'kanban',
  smokeTest: 'print(1)',
  harnessTools: ['save_comment', 'update_issue'],
  harnessToolsBySurface: [
    { slug: 'linear', surfaceClass: 'kanban', tools: ['save_comment', 'update_issue'] },
  ],
  authorAgentId: 'priya',
};

describe('adoptionFit', (): void => {
  it('fits an adopter with a connected surface of the class that allows every tool, and names that surface', (): void => {
    expect(adoptionFit(VERSION, MATEO)).toEqual({ fits: true, connection: LINEAR });
  });

  it('refuses an adopter with no connected surface of the class', (): void => {
    const unconnected = { ...MATEO, surfaces: [{ ...LINEAR, connected: false }, SLACK] };
    expect(adoptionFit(VERSION, unconnected)).toEqual({
      fits: false,
      mismatch: 'no-connected-surface',
      detail: 'there is no connected kanban surface',
    });
    expect(adoptionFit(VERSION, { ...MATEO, surfaces: [SLACK] })).toMatchObject({
      fits: false,
      mismatch: 'no-connected-surface',
    });
  });

  it('refuses an adopter whose surface of the class lacks a tool the version names in its approved allowlist', (): void => {
    const narrower = {
      ...MATEO,
      surfaces: [{ ...LINEAR, approvedTools: ['save_comment'] }, SLACK],
    };
    expect(adoptionFit(VERSION, narrower)).toEqual({
      fits: false,
      mismatch: 'tool-not-approved',
      detail: 'the approved tools of Linear do not include update_issue',
    });
  });

  it('reads the tools surface by surface, so a tool on a second system needs that system connected and approved', (): void => {
    const replying: AdoptableVersion = {
      ...VERSION,
      harnessTools: ['save_comment', 'chat.postMessage'],
      harnessToolsBySurface: [
        { slug: 'linear', surfaceClass: 'kanban', tools: ['save_comment'] },
        { slug: 'slack', surfaceClass: 'chat', tools: ['chat.postMessage'] },
      ],
    };
    expect(adoptionFit(replying, MATEO)).toMatchObject({ fits: true });
    expect(adoptionFit(replying, { ...MATEO, surfaces: [LINEAR] })).toEqual({
      fits: false,
      mismatch: 'no-connected-surface',
      detail: 'there is no connected chat surface',
    });
    const quiet = { ...MATEO, surfaces: [LINEAR, { ...SLACK, approvedTools: [] }] };
    expect(adoptionFit(replying, quiet)).toEqual({
      fits: false,
      mismatch: 'tool-not-approved',
      detail: 'the approved tools of Slack do not include chat.postMessage',
    });
  });

  it('matches an entry with no class by its slug, and checks the flat list against the class surface when no entry is kept', (): void => {
    const unclassed: AdoptableVersion = {
      ...VERSION,
      harnessToolsBySurface: [{ slug: 'slack', tools: ['chat.postMessage'] }],
    };
    expect(adoptionFit(unclassed, MATEO)).toMatchObject({ fits: true });
    expect(adoptionFit(unclassed, { ...MATEO, surfaces: [LINEAR] })).toMatchObject({
      fits: false,
      mismatch: 'no-connected-surface',
      detail: 'there is no connected surface slack',
    });
    const flat: AdoptableVersion = { ...VERSION, harnessToolsBySurface: undefined };
    expect(adoptionFit(flat, MATEO)).toMatchObject({ fits: true });
    expect(
      adoptionFit(flat, { ...MATEO, surfaces: [{ ...LINEAR, approvedTools: ['get_issue'] }] }),
    ).toMatchObject({ fits: false, mismatch: 'tool-not-approved' });
  });

  it('refuses an adopter whose charter names no system of the class and whose surface carries no charter evidence', (): void => {
    const unchartered: Adopter = {
      ...MATEO,
      charterClasses: ['chat'],
      surfaces: [{ ...LINEAR, charterEvidence: false }, SLACK],
    };
    expect(adoptionFit(VERSION, unchartered)).toEqual({
      fits: false,
      mismatch: 'no-charter-evidence',
      detail: 'the charter names no kanban system',
    });
    expect(adoptionFit(VERSION, { ...unchartered, surfaces: [LINEAR, SLACK] })).toMatchObject({
      fits: true,
    });
    expect(adoptionFit(VERSION, { ...unchartered, charterClasses: ['kanban'] })).toMatchObject({
      fits: true,
    });
  });

  it('takes the mock office for every connection in mock mode and still asks the charter for the system', (): void => {
    const mock: Adopter = {
      agentId: 'mateo',
      mode: 'mock',
      surfaces: [],
      charterClasses: ['kanban'],
    };
    expect(adoptionFit({ ...VERSION, harnessTools: [], harnessToolsBySurface: [] }, mock)).toEqual({
      fits: true,
    });
    expect(adoptionFit(VERSION, { ...mock, charterClasses: ['chat'] })).toMatchObject({
      fits: false,
      mismatch: 'no-charter-evidence',
    });
  });
});

describe('isOfferedTo and chooseOffer', (): void => {
  it("offers an offerable version another employee wrote, never the adopter's own", (): void => {
    expect(isOfferedTo(VERSION, MATEO)).toBe(true);
    expect(isOfferedTo({ ...VERSION, authorAgentId: 'mateo' }, MATEO)).toBe(false);
    expect(isOfferedTo({ ...VERSION, authorAgentId: undefined }, MATEO)).toBe(true);
  });

  it('offers nothing revoked, superseded or without a kept check', (): void => {
    expect(isOfferedTo({ ...VERSION, revokedAt: 5 }, MATEO)).toBe(false);
    expect(isOfferedTo({ ...VERSION, supersededAt: 5 }, MATEO)).toBe(false);
    expect(isOfferedTo({ ...VERSION, smokeTest: undefined }, MATEO)).toBe(false);
  });

  it('chooses the newest version of the name that is offered and fits, passing over the rest', (): void => {
    const newest = {
      ...VERSION,
      version: 3,
      harnessTools: ['close_everything'],
      harnessToolsBySurface: undefined,
    };
    const own = { ...VERSION, version: 2, authorAgentId: 'mateo' };
    const fitting = { ...VERSION, version: 1 };
    const otherName = { ...VERSION, version: 4, name: 'kanban-comment' };
    expect(chooseOffer([otherName, newest, own, fitting], VERSION.name, MATEO)).toBe(fitting);
    expect(chooseOffer([newest, own], VERSION.name, MATEO)).toBeUndefined();
    expect(chooseOffer([], VERSION.name, MATEO)).toBeUndefined();
  });
});

describe('missingScopes', (): void => {
  it('is the needed scopes the adopter holds no grant for, once each, in order', (): void => {
    expect(
      missingScopes(
        ['linear:read', 'linear:write', 'linear:write', 'boss:message'],
        ['linear:read'],
      ),
    ).toEqual(['linear:write', 'boss:message']);
    expect(missingScopes(['linear:read'], ['linear:read'])).toEqual([]);
    expect(missingScopes(undefined, [])).toEqual([]);
  });
});

describe('adoptionCardState', (): void => {
  it('reads an offered proposal, a verification in flight and a failed one from the row', (): void => {
    expect(adoptionCardState({ state: 'proposed', offeredVersionId: 'v1' })).toBe('offered');
    for (const state of ['approved', 'authoring', 'verified'] as const) {
      expect(adoptionCardState({ state, offeredVersionId: 'v1' })).toBe('verifying');
    }
    expect(adoptionCardState({ state: 'failed', offeredVersionId: 'v1' })).toBe('failed');
  });

  it('reads nothing for a row with no offer or one whose offer is answered', (): void => {
    expect(adoptionCardState({ state: 'proposed' })).toBeUndefined();
    for (const state of ['registered', 'rejected', 'retired', 'superseded'] as const) {
      expect(adoptionCardState({ state, offeredVersionId: 'v1' })).toBeUndefined();
    }
  });
});

describe('verifiedOnDay', (): void => {
  it('prints the day in the zone given, the same on every runtime', (): void => {
    const at = Date.UTC(2026, 8, 18, 23, 30);
    expect(verifiedOnDay(at, 'UTC')).toBe('18 September 2026');
    expect(verifiedOnDay(at, 'Asia/Singapore')).toBe('19 September 2026');
  });
});

describe('adoptionWords', (): void => {
  const base = {
    adopterName: 'Mateo',
    authorName: 'Priya',
    skillName: 'kanban-comment-and-close',
    verifiedOn: '18 September 2026',
    connection: 'Linear',
  };

  it("says whose skill does this, and that it is re-verified under the adopter's own connection before use", (): void => {
    expect(adoptionWords({ ...base, state: 'offered' })).toEqual({
      lead: "Priya's skill kanban-comment-and-close, verified on 18 September 2026, does this.",
      body: "Mateo can adopt it. It would be re-verified in the sandbox under Mateo's Linear connection before Mateo can use it.",
      scopesLead: 'Scopes Mateo would gain',
      noScopes: 'Mateo already holds every scope it needs.',
    });
  });

  it("words a copy handed over from another manager as its own case, never as that author's name", (): void => {
    const words = adoptionWords({ ...base, authorName: HANDED_OVER_AUTHOR_NAME, state: 'offered' });
    expect(words.lead).toBe(
      'The skill kanban-comment-and-close, which came with an employee handed over to you and was verified on 18 September 2026, does this.',
    );
    expect(Object.values(words).join(' ')).not.toContain(HANDED_OVER_AUTHOR_NAME);
  });

  it('says the sandbox alone in mock mode, where there is no connection to name', (): void => {
    const { body } = adoptionWords({ ...base, connection: undefined, state: 'offered' });
    expect(body).toBe(
      'Mateo can adopt it. It would be re-verified in the sandbox before Mateo can use it.',
    );
  });

  it('says what each later state means for the adopter', (): void => {
    expect(adoptionWords({ ...base, state: 'verifying' })).toMatchObject({
      lead: "Adopting Priya's skill kanban-comment-and-close for Mateo.",
      body: "It is being re-verified in the sandbox under Mateo's Linear connection. Mateo can use it once the check passes; there is nothing to press until then.",
    });
    expect(adoptionWords({ ...base, state: 'failed' })).toMatchObject({
      lead: "Priya's skill kanban-comment-and-close failed its re-verification for Mateo.",
      body: 'Mateo cannot use it. Write a new one instead to have Mateo write and verify one of its own, or decline it.',
    });
    expect(adoptionWords({ ...base, state: 'declined' })).toMatchObject({
      lead: "You declined Priya's skill kanban-comment-and-close for Mateo.",
      body: 'Mateo will not adopt it, and the work that needed it was cancelled.',
    });
  });

  it('carries no em dash and names no pronoun for the adopter', (): void => {
    for (const state of ['offered', 'verifying', 'failed', 'declined'] as const) {
      const text = Object.values(adoptionWords({ ...base, state })).join(' ');
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/\b(she|he|her|his)\b/i);
    }
  });
});

describe('adoptionHelp', (): void => {
  it('says what approving does, either way when a card offers an adoption', (): void => {
    expect(adoptionHelp('Mateo', false)).toBe(
      "Approving writes the skill and checks it in a sandbox, then evaluates again the item that needs it. Whether that work is within Mateo's charter is judged separately.",
    );
    expect(adoptionHelp('Mateo', true)).toBe(
      "Either way the skill is checked in a sandbox before it runs, then the item that needs it is evaluated again. Whether that work is within Mateo's charter is judged separately.",
    );
  });
});
