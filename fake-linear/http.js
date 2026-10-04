/**
 * The fake's answers on the Fetch API: JSON in the content type real Linear answered with, the
 * HTML pages, and the request readers every handler shares.
 */

/** The content type every Linear OAuth and GraphQL answer the walks logged carried. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * A JSON answer.
 *
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
export function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': JSON_CONTENT_TYPE, 'cache-control': 'no-store', ...headers },
  });
}

/**
 * An HTML page.
 *
 * @param {number} status
 * @param {string} title
 * @param {string} body the page's body, already escaped
 * @returns {Response}
 */
export function page(status, title, body) {
  const html =
    '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)}</title>` +
    '<style>body{font:16px system-ui;margin:2rem auto;max-width:30rem;padding:0 1rem}' +
    'ul{padding-left:1.25rem}button{min-height:44px;padding:.5rem 1rem;margin-right:.5rem}' +
    '.note{color:#555;font-size:14px}</style></head><body>' +
    body +
    '</body></html>';
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A form body's fields, or a JSON body's string fields, whichever the request carries.
 *
 * @param {Request} request
 * @returns {Promise<URLSearchParams>}
 */
export async function formOf(request) {
  const text = await request.text();
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('application/json')) return new URLSearchParams(text);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON after all: no fields, as an empty form.
    return new URLSearchParams();
  }
  const fields = new URLSearchParams();
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'string') fields.set(name, value);
    }
  }
  return fields;
}

/**
 * The token a request presents in its `Authorization` header: after `Bearer `, or the whole header
 * where it carries none (Linear documents a personal API key sent bare).
 *
 * @param {Request} request
 * @returns {string}
 */
export function presentedToken(request) {
  const header = (request.headers.get('authorization') ?? '').trim();
  return /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : header;
}
