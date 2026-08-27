/**
 * What the team's chat policy page says, read the same way by every caller.
 *
 * Intake reads the documented channel list to know where to look for work, and
 * the probe reads the same list to say which of them the employee's app has not
 * been invited to yet. Both must agree about what the page names, so the rule
 * lives here rather than once per caller.
 */

export interface PolicyPage {
  markdown: string;
  title: string;
}

export interface ChannelMembership {
  isMember: boolean;
  name: string;
}

/**
 * Read chat channel names from a policy page's explicit `Channels:` field.
 *
 * Args:
 *   pages: Documentation pages visible to one agent.
 *
 * Returns:
 *   Unique channel names without the hash prefix, in the order documented.
 */
export function documentedChannelNames(pages: readonly PolicyPage[]): string[] {
  const names = new Set<string>();
  for (const page of pages) {
    if (!/slack/i.test(`${page.title}\n${page.markdown}`)) continue;
    for (const line of page.markdown.split(/\r?\n/)) {
      if (!/\bChannels?\s*:/i.test(line)) continue;
      for (const match of line.matchAll(/#([a-z0-9][a-z0-9_-]*)/gi)) {
        names.add(match[1].toLowerCase());
      }
    }
  }
  return [...names];
}

/**
 * Decide which documented channels the app still has to be invited to.
 *
 * A public channel is visible to any app holding `channels:read`, member or
 * not, so the two failure shapes are different and are reported as one list of
 * channel names either way: a channel present but with `is_member` false has to
 * be invited, and a documented channel absent from the workspace listing cannot
 * be read whatever happens next. Neither is something the employee can fix, and
 * neither stops the manager DM working, so both are reported rather than raised.
 *
 * Args:
 *   documented: Channel names the policy page listed.
 *   visible: Channels the provider listed, with their membership flag.
 *
 * Returns:
 *   The documented names, hash-prefixed, that the app cannot yet read.
 */
export function channelsAwaitingInvite(
  documented: readonly string[],
  visible: readonly ChannelMembership[],
): string[] {
  const membership = new Map<string, boolean>(
    visible.map((channel: ChannelMembership): [string, boolean] => [
      channel.name.toLowerCase(),
      channel.isMember,
    ]),
  );
  return documented
    .map((name: string): string => name.toLowerCase())
    .filter((name: string): boolean => membership.get(name) !== true)
    .map((name: string): string => `#${name}`);
}
