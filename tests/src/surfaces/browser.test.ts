import { describe, expect, it } from 'vitest';
import {
  BROWSER_TOOLS,
  BrowserBoundError,
  browserDriverUrl,
  DEFAULT_BROWSER_MCP_URL,
  navigationRefusal,
  withinDocumentedSurface,
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
