/*
 * One turn's words as the one-to-one draws them, live in the room and read back from a stored
 * transcript alike, so the manager never sees the model's markdown marks in one place and bold
 * text in the other.
 */

/**
 * Split one turn into plain and emphasised runs.
 *
 * A turn renders the model's text verbatim, and some models write the
 * topic label as `**Topic 4:**`. Terra's recorded run wrote none, so the
 * markers only became visible once another model was configured - and a
 * manager reads this transcript closely. Rendering the emphasis is model-agnostic and
 * changes nothing that is sent: the transcript the charter is synthesised from
 * is still the model's own text.
 *
 * Only a matched, non-empty `**…**` pair counts. An unclosed or empty marker is
 * kept exactly as written rather than guessed at.
 *
 * Args:
 *   text: One text part of a transcript message.
 *
 * Returns:
 *   Consecutive runs in order, each flagged as emphasised or not.
 */
export function emphasisSegments(text: string): { text: string; strong: boolean }[] {
  const segments: { text: string; strong: boolean }[] = [];
  let plain = '';
  let rest = text;
  const emphasised = /\*\*([^*]+?)\*\*/;
  for (let match = emphasised.exec(rest); match; match = emphasised.exec(rest)) {
    plain += rest.slice(0, match.index);
    if (plain) segments.push({ text: plain, strong: false });
    plain = '';
    segments.push({ text: match[1], strong: true });
    rest = rest.slice(match.index + match[0].length);
  }
  if (plain + rest) segments.push({ text: plain + rest, strong: false });
  return segments;
}

/**
 * One turn's words, the model's `**…**` emphasis drawn bold and every other character as written.
 *
 * @param text - The turn's text.
 */
export function TurnText({ text }: { text: string }) {
  return (
    <>
      {emphasisSegments(text).map((segment, index) =>
        segment.strong ? (
          <strong key={index} className="font-semibold">
            {segment.text}
          </strong>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
