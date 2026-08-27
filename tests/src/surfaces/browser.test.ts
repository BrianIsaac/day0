import { describe, expect, it } from 'vitest';
import {
  BROWSER_TOOLS,
  BrowserBoundError,
  browserDriverUrl,
  browserPageUrl,
  browserPageTitle,
  browserTitleMarker,
  DEFAULT_BROWSER_MCP_URL,
  elementDescriptions,
  navigationRefusal,
  navigationResultRefusal,
  needsElementRef,
  parseSnapshotRefs,
  refFieldFor,
  resolveElementRef,
  withinDocumentedSurface,
  withResolvedRefs,
} from '../../../src/surfaces/browser';

const TILE = 'http://looker-tile:8080/';

describe('the browser driver address', (): void => {
  it('falls back to the bundled service when nothing is configured', (): void => {
    expect(browserDriverUrl(undefined).href).toBe(DEFAULT_BROWSER_MCP_URL);
    expect(browserDriverUrl('   ').href).toBe(DEFAULT_BROWSER_MCP_URL);
  });

  it('takes a configured address', (): void => {
    expect(browserDriverUrl('http://browser:9000/mcp').href).toBe('http://browser:9000/mcp');
  });

  it('refuses a configured value that is not a URL', (): void => {
    expect(() => browserDriverUrl('playwright-mcp:8931')).toThrow(BrowserBoundError);
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
    expect(
      browserTitleMarker('- Probe marker: page title `Pipeline coverage - Looker`.'),
    ).toBe('Pipeline coverage - Looker');
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
