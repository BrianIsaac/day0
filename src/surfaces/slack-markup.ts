/*
 * Slack's markup in what Day0 quotes into a message to the manager. Slack reads `<!here>`, `<@U…>`
 * and `<#C…>` in a message's text as a mention or a link, and asks a sender to escape `&`, `<` and
 * `>` in anything meant as text (Slack's "Formatting text for app surfaces", read for 12-H). A title,
 * a plan, an action's body or a run's sentence comes from a model or a ticket, so every builder of a
 * message escapes what it quotes through `slackEscaped`, and a quoted control sequence is text
 * (12-H's "For the cockpit"; the walk on real Slack, row 19).
 */

/**
 * A text with the three characters Slack reads as markup escaped as Slack asks, ampersand first,
 * so it reads as written and never as a mention or a link.
 */
export function slackEscaped(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An entity `slackEscaped` writes, cut short at the end of a text. */
const CUT_ENTITY = /&[a-z]*$/;

/**
 * An escaped text cut to `limit` characters with an ellipsis, never inside an entity
 * `slackEscaped` wrote, so a cut line never shows `&l` where a `<` was.
 *
 * @param text - A text already escaped by {@link slackEscaped}.
 * @param limit - The most characters the result may carry, the ellipsis included.
 */
export function clippedSlackText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).replace(CUT_ENTITY, '')}…`;
}
