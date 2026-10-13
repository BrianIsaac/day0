/*
 * The hosted office's references in a manager's words (W19-7). A mock work item names the records
 * it is about by reference (`docs-fixture/billing-replies`, `channel://office-asks#thread-double-
 * charge`), and on the v0.19.0 walk the planner and the executor copied them into plans and into a
 * DM the manager read: `docs-fixture/billing-replies` in ten places, `channel://...` in six. The
 * prompts now say to name a record by what it is, and this is the floor under them: every such
 * reference left in a plan, a draft or a message reads as the record it names.
 */

/** One reference in the text, by its scheme, its record and the thread or fragment after it. */
const REFERENCE =
  /\b(docs-fixture\/|channel:\/\/|mock-spreadsheet:\/\/|ticket:\/\/|twitter:\/\/)([\w-]+)(?:#([\w-]+))?/g;

/** A slug as words: its hyphens as spaces. */
function slugWords(slug: string): string {
  return slug.replace(/-+/g, ' ').trim();
}

/** A thread's key as words, without the `thread-` the office gives every key. */
function threadWords(key: string): string {
  return slugWords(key.replace(/^thread-/, ''));
}

/** One reference as a manager reads it. */
function plainName(scheme: string, slug: string, fragment: string | undefined): string {
  switch (scheme) {
    case 'docs-fixture/':
      return `the ${slugWords(slug)} page`;
    case 'channel://':
      return fragment ? `the ${threadWords(fragment)} thread in #${slug}` : `#${slug}`;
    case 'mock-spreadsheet://':
      return `the ${slugWords(slug)} sheet`;
    case 'ticket://':
      return slug;
    case 'twitter://':
      return `the social post ${slugWords(slug)}`;
    default:
      return `${scheme}${slug}${fragment ? `#${fragment}` : ''}`;
  }
}

/**
 * A text with every hosted office reference written as the record it names: a page, a thread in
 * a channel, a channel, a sheet, a ticket's key or a social post. A page's reference in
 * parentheses beside the name it repeats ("the billing replies doc (docs-fixture/billing-replies)")
 * is dropped with its parentheses; any other reference is named in place ("(REVOPS-204)").
 *
 * @param text - A plan's step, a draft or a message as the model wrote it.
 * @returns The text with no `docs-fixture/` or `<scheme>://` reference left.
 */
export function inPlainNames(text: string): string {
  // A page's reference in parentheses repeats the page its words named; any other is kept, named.
  const bracketed = /\s*\(docs-fixture\/[\w-]+\)/g;
  return text
    .replace(bracketed, '')
    .replace(REFERENCE, (_whole, scheme: string, slug: string, fragment: string | undefined) =>
      plainName(scheme, slug, fragment),
    );
}

/**
 * The references a mock work item names, as the prompts print them: by what each record is,
 * with the identifier an action needs beside it, never the reference's scheme.
 *
 * @param refs - The item's `contentRefs`.
 * @returns One line's worth, or `(none)`.
 */
export function refsInWords(refs: readonly string[]): string {
  if (refs.length === 0) return '(none)';
  return refs
    .map((ref) => {
      const match = new RegExp(`^${REFERENCE.source}$`).exec(ref);
      if (!match) return ref;
      const [, scheme, slug, fragment] = match;
      switch (scheme) {
        case 'docs-fixture/':
          return `the team document ${slug}`;
        case 'channel://':
          return fragment ? `thread ${fragment} in channel ${slug}` : `channel ${slug}`;
        case 'mock-spreadsheet://':
          return `the spreadsheet ${slug}`;
        case 'ticket://':
          return `ticket ${slug}`;
        case 'twitter://':
          return `the social post ${slug}`;
        default:
          return ref;
      }
    })
    .join('; ');
}
