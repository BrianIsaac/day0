/**
 * The Block Kit shapes Day0's manager DM messages carry (Slack's own field names), kept apart
 * from the builders so the message actions and the builders share them without importing each
 * other.
 */

/** A Block Kit text object. */
export interface SlackText {
  readonly type: 'mrkdwn' | 'plain_text';
  readonly text: string;
}

/** A Block Kit confirmation dialog, shown before a button's press is sent. */
export interface SlackConfirm {
  readonly title: SlackText;
  readonly text: SlackText;
  readonly confirm: SlackText;
  readonly deny: SlackText;
  readonly style: 'primary' | 'danger';
}

/** A Block Kit button whose press reaches the app as a `block_actions` payload. */
export interface SlackButton {
  readonly type: 'button';
  readonly action_id: string;
  readonly value: string;
  readonly text: SlackText;
  readonly style: 'primary' | 'danger';
  readonly confirm?: SlackConfirm;
}

/** A Block Kit section block: one run of the message's text. */
export interface SlackSectionBlock {
  readonly type: 'section';
  readonly text: SlackText;
}

/** A Block Kit actions block: the request's buttons. */
export interface SlackActionsBlock {
  readonly type: 'actions';
  readonly block_id: string;
  readonly elements: readonly SlackButton[];
}

/** A block a decision request's message carries. */
export type SlackBlock = SlackSectionBlock | SlackActionsBlock;
