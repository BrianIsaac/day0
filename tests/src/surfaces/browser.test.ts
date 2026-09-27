import { describe, expect, it } from 'vitest';
import {
  BROWSER_COMPONENT_CARD_MESSAGE,
  BROWSER_DRIVER_ABSENT,
  BROWSER_DRIVER_ABSENT_REASON,
  BROWSER_TOOLS,
  BrowserBoundError,
  browserComponent,
  browserPageUrl,
  browserPageTitle,
  browserTitleMarker,
  carriesSecretPlaceholder,
  isCredentialField,
  isLoginNameField,
  DEFAULT_BROWSER_MCP_URL,
  elementDescriptions,
  navigationRefusal,
  navigationResultRefusal,
  isDriverUnreachable,
  needsElementRef,
  parseSnapshotRefs,
  presentBrowserComponent,
  refFieldFor,
  resolveElementRef,
  secretPlacementRefusal,
  unknownPlaceholderRefusal,
  withinDocumentedSurface,
  withResolvedRefs,
  withSecretTyped,
  type SnapshotElement,
} from '../../../src/surfaces/browser';
import { dashboardPage, SIGN_IN_PAGE } from '../../fixtures/browser-phase-split-2026-09-16';
import { RELABELLED_SIGN_IN_PAGE } from '../../fixtures/browser-sign-in-relabelled-2026-09-28';

const TILE = 'http://looker-tile:8080/';

describe('the browser component', (): void => {
  it('is absent when no driver address is configured', (): void => {
    for (const configured of [undefined, '', '   ']) {
      const component = browserComponent(configured);
      expect(component.present).toBe(false);
      if (component.present) throw new Error('unreachable');
      expect(component.code).toBe(BROWSER_DRIVER_ABSENT);
      expect(component.reason).toBe(BROWSER_DRIVER_ABSENT_REASON);
      expect(component.reason).toContain('--profile browser');
    }
  });

  it('is present at the address configured for it', (): void => {
    const component = browserComponent('http://browser:9000/mcp');
    expect(component.present).toBe(true);
    if (!component.present) throw new Error('unreachable');
    expect(component.url.href).toBe('http://browser:9000/mcp');
  });

  it('is present at the bundled address the browser profile starts', (): void => {
    const component = browserComponent(DEFAULT_BROWSER_MCP_URL);
    expect(component.present).toBe(true);
  });

  it('reports a malformed address as a typo rather than an absent component', (): void => {
    expect(() => browserComponent('playwright-mcp:8931')).toThrow(BrowserBoundError);
    expect(() => browserComponent('not a url')).toThrow(BrowserBoundError);
  });
});

describe('a driver that is not listening', (): void => {
  it('reads a connection failure as the component being absent', (): void => {
    expect(isDriverUnreachable(new Error('fetch failed'))).toBe(true);
    expect(isDriverUnreachable(new Error('connect ECONNREFUSED 172.18.0.5:8931'))).toBe(true);
    expect(isDriverUnreachable('getaddrinfo ENOTFOUND playwright-mcp')).toBe(true);
  });

  it("reads the MCP client's own wording, which hides the cause", (): void => {
    // Verbatim from a live probe against a stopped component.
    expect(
      isDriverUnreachable(
        'Failed to connect to MCP server surface: Error: Could not connect to server with any available HTTP transport',
      ),
    ).toBe(true);
  });

  it('reads a wrapped transport failure through its cause', (): void => {
    const wrapped = new Error('MCP client failed', { cause: new Error('connect ECONNREFUSED') });
    expect(isDriverUnreachable(wrapped)).toBe(true);
  });

  it('leaves a driver that answered and refused with its own words', (): void => {
    expect(isDriverUnreachable(new Error('Browser is already in use'))).toBe(false);
    expect(isDriverUnreachable(new Error('the documented page could not be opened'))).toBe(false);
    expect(isDriverUnreachable(undefined)).toBe(false);
  });
});

describe('what the card says about the browser component', (): void => {
  it('says nothing on a path that does not use a browser', (): void => {
    expect(presentBrowserComponent({ componentPresent: false, path: 'mcp' })).toEqual({
      absent: false,
    });
    expect(presentBrowserComponent({ componentPresent: false, path: undefined })).toEqual({
      absent: false,
    });
  });

  it('names the system, the component and the profile when nothing is configured', (): void => {
    const shown = presentBrowserComponent({ componentPresent: false, path: 'browser-driven' });
    expect(shown.absent).toBe(true);
    expect(shown.message).toBe(BROWSER_COMPONENT_CARD_MESSAGE);
    expect(shown.message).toContain('reached through its web UI');
    expect(shown.message).toContain('--profile browser');
  });

  it('says the same thing when a configured driver turned out not to be there', (): void => {
    const shown = presentBrowserComponent({
      componentPresent: true,
      path: 'browser-driven',
      reason: BROWSER_DRIVER_ABSENT_REASON,
    });
    expect(shown.absent).toBe(true);
    expect(shown.message).toBe(BROWSER_COMPONENT_CARD_MESSAGE);
  });

  it('stays out of the way once the component is there', (): void => {
    expect(
      presentBrowserComponent({
        componentPresent: true,
        path: 'browser-driven',
        reason: 'the documented page title marker was not present (Sign in - Looker)',
      }),
    ).toEqual({ absent: false });
  });
});

describe('the tools the floor may use', (): void => {
  it('is the set a person needs to read a page and complete a form', (): void => {
    expect([...BROWSER_TOOLS]).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_fill_form',
    ]);
  });

  it('excludes everything that turns a browser into a general runtime', (): void => {
    for (const tool of [
      'browser_evaluate',
      'browser_run_code_unsafe',
      'browser_file_upload',
      'browser_tabs',
      'browser_network_requests',
      'browser_take_screenshot',
      'browser_handle_dialog',
    ]) {
      expect(BROWSER_TOOLS).not.toContain(tool);
    }
  });
});

describe('the origin bound', (): void => {
  it('admits the documented page and anything under it', (): void => {
    expect(withinDocumentedSurface(TILE, TILE)).toBe(true);
    expect(withinDocumentedSurface('http://looker-tile:8080/login', TILE)).toBe(true);
    expect(withinDocumentedSurface('http://looker-tile:8080/tile?saved=1', TILE)).toBe(true);
  });

  it('refuses another host', (): void => {
    expect(withinDocumentedSurface('http://evil.example/', TILE)).toBe(false);
    expect(withinDocumentedSurface('http://169.254.169.254/latest/meta-data/', TILE)).toBe(false);
  });

  it('refuses another port or scheme on the same name', (): void => {
    expect(withinDocumentedSurface('http://looker-tile:9090/', TILE)).toBe(false);
    expect(withinDocumentedSurface('https://looker-tile:8080/', TILE)).toBe(false);
  });

  it('refuses a sibling path outside a documented subpath', (): void => {
    const dashboard = 'http://looker-tile:8080/dashboards/7';
    expect(withinDocumentedSurface('http://looker-tile:8080/dashboards/7/edit', dashboard)).toBe(
      true,
    );
    expect(withinDocumentedSurface(dashboard, dashboard)).toBe(true);
    expect(withinDocumentedSurface('http://looker-tile:8080/admin', dashboard)).toBe(false);
    expect(withinDocumentedSurface('http://looker-tile:8080/dashboards/70', dashboard)).toBe(false);
  });

  it('refuses anything that is not a URL', (): void => {
    expect(withinDocumentedSurface('javascript:alert(1)', TILE)).toBe(false);
    expect(withinDocumentedSurface('/admin', TILE)).toBe(false);
    expect(withinDocumentedSurface(TILE, 'not-a-url')).toBe(false);
  });
});

describe('refusing a browser action that would leave the surface', (): void => {
  it('says nothing about a tool that names no destination', (): void => {
    expect(navigationRefusal('browser_snapshot', {}, TILE)).toBeUndefined();
    expect(navigationRefusal('browser_click', { ref: 'e5' }, TILE)).toBeUndefined();
  });

  it('admits a navigation inside the approved surface', (): void => {
    expect(navigationRefusal('browser_navigate', { url: TILE }, TILE)).toBeUndefined();
  });

  it('refuses a navigation outside it, naming the surface', (): void => {
    expect(navigationRefusal('browser_navigate', { url: 'http://evil.example/' }, TILE)).toBe(
      `navigation outside the approved surface (${TILE})`,
    );
  });

  it('refuses a navigation with no url', (): void => {
    expect(navigationRefusal('browser_navigate', {}, TILE)).toBe(
      'browser_navigate was given no url',
    );
    expect(navigationRefusal('browser_navigate', { url: '  ' }, TILE)).toBe(
      'browser_navigate was given no url',
    );
  });

  it('refuses when the surface documents no address at all', (): void => {
    expect(navigationRefusal('browser_navigate', { url: TILE }, undefined)).toBe(
      'the surface has no documented address to browse',
    );
  });
});

describe('checking where a browser navigation landed', (): void => {
  it('reads the pinned driver Page URL and admits the approved surface', (): void => {
    const result = `### Page\n- Page URL: ${TILE}\n- Page Title: Pipeline coverage - Looker`;
    expect(browserPageUrl(result)).toBe(TILE);
    expect(browserPageTitle(result)).toBe('Pipeline coverage - Looker');
    expect(navigationResultRefusal('browser_navigate', result, TILE)).toBeUndefined();
  });

  it('reads only an explicit backticked title marker from documentation', (): void => {
    expect(browserTitleMarker('- Probe marker: page title `Pipeline coverage - Looker`.')).toBe(
      'Pipeline coverage - Looker',
    );
    expect(browserTitleMarker('Open the browser and look for Pipeline coverage.')).toBeUndefined();
  });

  it('refuses a redirect to another origin', (): void => {
    const result = '### Page\n- Page URL: http://unexpected.internal/login';
    expect(navigationResultRefusal('browser_navigate', result, TILE)).toContain(
      'redirected outside the approved surface',
    );
  });

  it('refuses a navigation result with no final location', (): void => {
    expect(navigationResultRefusal('browser_navigate', 'opened', TILE)).toBe(
      'the browser driver reported no final page URL',
    );
  });
});

const SNAPSHOT = [
  '### Page',
  '- Page URL: http://looker-tile:8080/',
  '### Snapshot',
  '```yaml',
  '- main [ref=e2]:',
  '  - generic [ref=e3]:',
  '    - generic [ref=e5]: Looker',
  '  - heading "Sign in" [level=1] [ref=e7]',
  '  - generic [ref=e10]: Username',
  '  - textbox "Username" [ref=e11]',
  '  - generic [ref=e13]: Password',
  '  - textbox "Password" [ref=e14]',
  '  - button "Sign in" [ref=e15] [cursor=pointer]',
  '```',
].join('\n');

const DASHBOARD = [
  '- textbox "Pipeline coverage" [ref=e21]',
  '- button "Save" [ref=e23] [cursor=pointer]',
  '- paragraph [ref=e24]: Last updated by revops at 2026-08-27 05:30:00 UTC',
].join('\n');

describe('reading the driver snapshot', (): void => {
  it('takes every named element with its ref and role', (): void => {
    const elements = parseSnapshotRefs(SNAPSHOT);
    expect(elements).toContainEqual({ name: 'Username', ref: 'e11', role: 'textbox' });
    expect(elements).toContainEqual({ name: 'Sign in', ref: 'e15', role: 'button' });
    expect(elements).toContainEqual({ name: 'Looker', ref: 'e5', role: 'generic' });
  });

  it('takes the ref the driver printed after a name, never one the name or the text carries', (): void => {
    const page = [
      '- link "Q3 plan [ref=e7]" [ref=e40] [cursor=pointer]',
      '- button "Delete dashboard" [ref=e7] [cursor=pointer]',
      '- link "Q3 \\" [ref=e8] review" [ref=e41]',
      '- generic [ref=e5]: Note [ref=e9]',
    ].join('\n');
    expect(parseSnapshotRefs(page)).toEqual([
      { name: 'Q3 plan [ref=e7]', ref: 'e40', role: 'link' },
      { name: 'Delete dashboard', ref: 'e7', role: 'button' },
      { name: 'Q3 " [ref=e8] review', ref: 'e41', role: 'link' },
      { name: 'Note [ref=e9]', ref: 'e5', role: 'generic' },
    ]);
    expect(resolveElementRef(page, 'Q3 plan')?.ref).toBe('e40');
  });

  it('reads nothing out of an empty or shapeless snapshot', (): void => {
    expect(parseSnapshotRefs('')).toEqual([]);
    expect(parseSnapshotRefs('nothing here')).toEqual([]);
  });
});

describe('resolving an element a skill named', (): void => {
  it('matches the accessible name exactly', (): void => {
    expect(resolveElementRef(SNAPSHOT, 'Sign in')?.ref).toBe('e15');
    expect(resolveElementRef(DASHBOARD, 'Save')?.ref).toBe('e23');
  });

  it('matches when the skill wrote the role into the description', (): void => {
    expect(resolveElementRef(DASHBOARD, 'Save button')?.ref).toBe('e23');
    expect(resolveElementRef(SNAPSHOT, 'Username field')?.ref).toBe('e11');
  });

  it('is case- and space-insensitive', (): void => {
    expect(resolveElementRef(DASHBOARD, '  save  ')?.ref).toBe('e23');
  });

  it('finds nothing rather than guessing when the page has no such element', (): void => {
    expect(resolveElementRef(DASHBOARD, 'Delete everything')).toBeUndefined();
    expect(resolveElementRef(DASHBOARD, '')).toBeUndefined();
  });

  it('refuses an ambiguous description rather than picking one', (): void => {
    const two = ['- button "Save" [ref=e1]', '- button "Save" [ref=e2]'].join('\n');
    expect(resolveElementRef(two, 'Save')).toBeUndefined();
  });

  // On the exported sign-in page the brand mark's accessible name is the
  // letter "L", which substring containment let stand for "Pipeline coverage".
  it('does not let a one-letter brand mark stand for a field it does not name', (): void => {
    expect(resolveElementRef(SIGN_IN_PAGE, 'Pipeline coverage')).toBeUndefined();
  });

  it('still resolves a description that adds a role word to a button name', (): void => {
    expect(resolveElementRef(dashboardPage({ value: '68%' }), 'Save button')).toEqual({
      name: 'Save',
      ref: 'e25',
      role: 'button',
    });
  });

  it('does not resolve a shorter generic name just because a role word was removed', (): void => {
    const page = '- generic "Save" [ref=e1]';
    expect(resolveElementRef(page, 'Save button')).toBeUndefined();
  });

  // P8-5, executed in pass 9: once the button is relabelled, "Sign in" named
  // only the heading, and the click on it came back ok as a completed sign-in.
  it('finds nothing to click once a redesign leaves only a heading with the name', (): void => {
    expect(resolveElementRef(SIGN_IN_PAGE, 'Sign in')?.ref).toBe('e15');
    expect(resolveElementRef(RELABELLED_SIGN_IN_PAGE, 'Sign in')).toBeUndefined();
    expect(resolveElementRef(RELABELLED_SIGN_IN_PAGE, 'Sign in', 'write')).toBeUndefined();
  });

  it('still lets a read name the lone heading', (): void => {
    expect(resolveElementRef(RELABELLED_SIGN_IN_PAGE, 'Sign in', 'read')).toEqual({
      name: 'Sign in',
      ref: 'e7',
      role: 'heading',
    });
  });

  // The write rule reads the role, so every ARIA widget a person clicks has
  // to count as one, or a tab or a tree row stops resolving for a click.
  it('still lets a write act on a lone tab, tree item, grid cell or checkable menu item', (): void => {
    for (const role of ['tab', 'treeitem', 'gridcell', 'menuitemcheckbox', 'menuitemradio']) {
      expect(resolveElementRef(`- ${role} "Pipeline" [ref=e3]`, 'Pipeline')).toEqual({
        name: 'Pipeline',
        ref: 'e3',
        role,
      });
    }
  });

  it('does not let a write reach a lone non-interactive element through a longer name', (): void => {
    const page = ['- heading "Sign in to Looker" [ref=e7]', '- button "Log in" [ref=e15]'].join(
      '\n',
    );
    expect(resolveElementRef(page, 'Sign in')).toBeUndefined();
    expect(resolveElementRef(page, 'Sign in', 'read')?.ref).toBe('e7');
  });

  it('still resolves a field whose name adds a unit to the description', (): void => {
    const page = ['- generic [ref=e4]: L', '- textbox "Pipeline coverage (%)" [ref=e24]'].join(
      '\n',
    );
    expect(resolveElementRef(page, 'Pipeline coverage')).toEqual({
      name: 'Pipeline coverage (%)',
      ref: 'e24',
      role: 'textbox',
    });
  });
});

describe('putting resolved refs back into an action', (): void => {
  it('knows which tools address an element', (): void => {
    expect(needsElementRef('browser_click')).toBe(true);
    expect(needsElementRef('browser_type')).toBe(true);
    expect(needsElementRef('browser_fill_form')).toBe(true);
    expect(needsElementRef('browser_navigate')).toBe(false);
    expect(needsElementRef('browser_snapshot')).toBe(false);
  });

  it('reads the description off a click and puts the ref back', (): void => {
    expect(elementDescriptions('browser_click', { element: 'Save' })).toEqual(['Save']);
    expect(
      withResolvedRefs('browser_click', { element: 'Save' }, [
        { name: 'Save', ref: 'e23', role: 'button' },
      ]),
    ).toEqual({ element: 'Save', target: 'e23' });
  });

  it('reads one description per form field and keeps their order', (): void => {
    const args = {
      fields: [
        { name: 'Username', value: 'revops' },
        { name: 'Password', value: 'secret' },
      ],
    };
    expect(elementDescriptions('browser_fill_form', args)).toEqual(['Username', 'Password']);
    expect(
      withResolvedRefs('browser_fill_form', args, [
        { name: 'Username', ref: 'e11', role: 'textbox' },
        { name: 'Password', ref: 'e14', role: 'textbox' },
      ]),
    ).toEqual({
      fields: [
        { name: 'Username', target: 'e11', type: 'textbox', value: 'revops' },
        { name: 'Password', target: 'e14', type: 'textbox', value: 'secret' },
      ],
    });
  });

  it('keeps a type the skill supplied rather than overwriting it', (): void => {
    expect(
      withResolvedRefs(
        'browser_fill_form',
        { fields: [{ name: 'Coverage', type: 'textbox', value: '74%' }] },
        [{ name: 'Coverage', ref: 'e21', role: 'generic' }],
      ),
    ).toEqual({ fields: [{ name: 'Coverage', target: 'e21', type: 'textbox', value: '74%' }] });
  });

  it('replaces a field type the driver would refuse', (): void => {
    // The driver's enum is textbox/checkbox/radio/combobox/slider, and it sets
    // additionalProperties:false - a `generic` role would fail validation.
    expect(
      withResolvedRefs('browser_fill_form', { fields: [{ name: 'Coverage', value: '74%' }] }, [
        { name: 'Coverage', ref: 'e21', role: 'generic' },
      ]),
    ).toEqual({ fields: [{ name: 'Coverage', target: 'e21', type: 'textbox', value: '74%' }] });
    expect(
      withResolvedRefs(
        'browser_fill_form',
        { fields: [{ name: 'Agree', type: 'toggle', value: 'true' }] },
        [{ name: 'Agree', ref: 'e9', role: 'checkbox' }],
      ),
    ).toEqual({ fields: [{ name: 'Agree', target: 'e9', type: 'checkbox', value: 'true' }] });
  });

  it('puts the reference in the field the discovered schema declares', (): void => {
    expect(refFieldFor(['element', 'target', 'button'])).toBe('target');
    expect(refFieldFor(['element', 'ref'])).toBe('ref');
    expect(refFieldFor(undefined)).toBe('target');
    expect(refFieldFor([])).toBe('target');
    expect(
      withResolvedRefs(
        'browser_click',
        { element: 'Save' },
        [{ name: 'Save', ref: 'e23', role: 'button' }],
        'ref',
      ),
    ).toEqual({ element: 'Save', ref: 'e23' });
  });

  it('leaves a tool that addresses no element alone', (): void => {
    expect(elementDescriptions('browser_navigate', { url: 'http://x/' })).toEqual([]);
    expect(withResolvedRefs('browser_navigate', { url: 'http://x/' }, [])).toEqual({
      url: 'http://x/',
    });
  });
});

describe('a placeholder left in a tool argument', (): void => {
  it('refuses any placeholder other than the credential, naming it and where it sits', (): void => {
    expect(
      unknownPlaceholderRefusal({
        fields: [
          { name: 'Password', value: '{{secret}}' },
          { name: 'Pipeline coverage', value: '{{ figure }} this quarter' },
        ],
      }),
    ).toBe(
      'unknown placeholder {{figure}} in fields.1.value: a value was left unfilled, so the call was not sent',
    );
    expect(unknownPlaceholderRefusal({ body: 'Coverage is {{}}' })).toContain(
      'unknown placeholder {{}} in body',
    );
    expect(unknownPlaceholderRefusal('{{secret:}}')).toContain('in the arguments');
  });

  it('leaves the credential placeholder and plain braces to the other checks', (): void => {
    expect(
      unknownPlaceholderRefusal({
        text: '{{secret}}',
        fields: [
          { value: '{{ secret }}' },
          { value: '{{secret:tile}}' },
          { value: '{{secret.tile}}' },
        ],
        body: 'a {single} brace and {{ unclosed',
        count: 3,
      }),
    ).toBeUndefined();
  });
});

describe('where a browser action may carry the credential', (): void => {
  const password: SnapshotElement = { name: 'Password', ref: 'e14', role: 'textbox' };
  const notes: SnapshotElement = { name: 'Password notes', ref: 'e30', role: 'textbox' };

  it('names a credential field and an account field apart, role words aside', (): void => {
    for (const name of ['Password', 'Password field', 'passcode', 'API key', 'Access code box']) {
      expect(isCredentialField(name)).toBe(true);
      expect(isLoginNameField(name)).toBe(false);
    }
    for (const name of ['Username', 'User name', 'E-mail address', 'Email field']) {
      expect(isLoginNameField(name)).toBe(true);
      expect(isCredentialField(name)).toBe(false);
    }
    for (const name of ['Password notes', 'Pipeline coverage', 42]) {
      expect(isCredentialField(name)).toBe(false);
      expect(isLoginNameField(name)).toBe(false);
    }
  });

  it('finds a placeholder anywhere in an argument tree', (): void => {
    expect(carriesSecretPlaceholder({ fields: [{ value: '{{ secret }}' }] })).toBe(true);
    expect(carriesSecretPlaceholder({ url: 'http://x/?t={{secret:tile}}' })).toBe(true);
    expect(carriesSecretPlaceholder({ text: '{{quarter}}' })).toBe(false);
  });

  it('admits the credential in a credential field typing slot only', (): void => {
    expect(
      secretPlacementRefusal(
        'browser_type',
        { element: 'Password field', text: '{{secret}}' },
        'tile',
      ),
    ).toBeUndefined();
    expect(
      secretPlacementRefusal(
        'browser_fill_form',
        { fields: [{ name: 'API key', value: '{{secret}}' }] },
        'tile',
      ),
    ).toBeUndefined();
    expect(
      secretPlacementRefusal('browser_type', { element: 'Comment', text: '{{secret}}' }, 'tile'),
    ).toContain('text of browser_type is not one');
    expect(
      secretPlacementRefusal(
        'browser_fill_form',
        { fields: [{ name: '{{secret}}', value: 'x' }] },
        'tile',
      ),
    ).toContain('fields.0.name');
  });

  // A user name or e-mail box shows what is typed into it, so the password
  // would sit on the page in clear text for anyone who reads it (P8-5).
  it('refuses the credential in a user name or e-mail field', (): void => {
    for (const name of ['Username', 'User name', 'E-mail', 'Email address']) {
      expect(
        secretPlacementRefusal(
          'browser_fill_form',
          { fields: [{ name, value: '{{secret}}' }] },
          'tile',
        ),
      ).toContain('typed only into a credential field');
    }
    expect(
      secretPlacementRefusal('browser_type', { element: 'Username', text: '{{secret}}' }, 'tile'),
    ).toContain('text of browser_type is not one');
  });

  it('refuses once the page resolved a password name to a control that is not a text box', (): void => {
    const toolArgs = { fields: [{ name: 'Password', value: '{{secret}}' }] };
    for (const role of ['button', 'link', 'combobox', 'checkbox']) {
      expect(
        secretPlacementRefusal('browser_fill_form', toolArgs, 'tile', [
          { name: 'Password', ref: 'e14', role },
        ]),
      ).toContain('typed only into a credential field');
    }
    expect(
      withSecretTyped(
        'browser_fill_form',
        { fields: [{ name: 'Password', target: 'e14', value: '{{secret}}' }] },
        [{ name: 'Password', ref: 'e14', role: 'button' }],
        'tile-password',
        'tile',
      ),
    ).toEqual({ fields: [{ name: 'Password', target: 'e14', value: '{{secret}}' }] });
  });

  it("refuses a placeholder naming another surface's credential", (): void => {
    expect(
      secretPlacementRefusal(
        'browser_fill_form',
        { fields: [{ name: 'Password', value: '{{secret:linear}}' }] },
        'tile',
      ),
    ).toContain('names another surface');
  });

  it('refuses once the page resolved the field to something that is not a credential field', (): void => {
    const toolArgs = { fields: [{ name: 'Password', value: '{{secret}}' }] };
    expect(
      secretPlacementRefusal('browser_fill_form', toolArgs, 'tile', [password]),
    ).toBeUndefined();
    expect(secretPlacementRefusal('browser_fill_form', toolArgs, 'tile', [notes])).toContain(
      'typed only into a credential field',
    );
  });

  it('types the credential into the admitted slots and nowhere else', (): void => {
    const typed = withSecretTyped(
      'browser_fill_form',
      {
        fields: [
          { name: 'Username', target: 'e11', value: 'revops' },
          { name: 'Password', target: 'e14', value: '{{secret}}' },
        ],
      },
      [{ name: 'Username', ref: 'e11', role: 'textbox' }, password],
      'tile-password',
      'tile',
    );
    expect(typed).toEqual({
      fields: [
        { name: 'Username', target: 'e11', value: 'revops' },
        { name: 'Password', target: 'e14', value: 'tile-password' },
      ],
    });
    expect(
      withSecretTyped(
        'browser_type',
        { element: 'Password', text: '{{secret}}' },
        [password],
        's',
        'tile',
      ),
    ).toEqual({ element: 'Password', text: 's' });
  });
});
