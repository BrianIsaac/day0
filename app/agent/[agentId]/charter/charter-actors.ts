import type { CharterConstraint, StruckClause } from '@/agent/charter-constraints';
import type { ActorAt } from './CharterAside';
import type { CharterCardBody } from './CharterCard';

/** An answered open question as the charter body keeps it. */
export type AnsweredQuestion = NonNullable<CharterCardBody['answeredQuestions']>[number];

/**
 * Who did what the record shows on the charter, in the page's words: "you", or the earlier
 * manager a handover took the employee from. A strike, an added rule and an answer each name the
 * manager who made them, as the versions list names who approved and amended.
 */
export interface CharterActors {
  /** Who struck a clause the record lists struck or rewritten. */
  readonly struck: (change: StruckClause) => string;
  /** Who answered an open question. */
  readonly answered: (entry: AnsweredQuestion) => string;
  /** Who added a rule the manager added. */
  readonly added: (constraint: CharterConstraint) => string;
}

/** The actors for a charter no handover touched: the reader did everything on it. */
export const READER_ACTED: CharterActors = {
  struck: () => 'you',
  answered: () => 'you',
  added: () => 'you',
};

/** A version of the charter as the actors read it: whether and when it came into force, and its body. */
export interface ActedVersion {
  readonly approved: boolean;
  readonly createdAt: number;
  readonly approvedAt?: number;
  readonly body: unknown;
}

/** When a version came into force: its approval, or, for an amendment, its writing. */
function inForceAt(version: ActedVersion): number {
  return version.approvedAt ?? version.createdAt;
}

/** The charter body of a version, as the card reads it. */
function bodyOf(version: ActedVersion): CharterCardBody {
  return version.body as CharterCardBody;
}

/** Whether two kept strikes are the same change to the same clause. */
function sameStrike(left: StruckClause, right: StruckClause): boolean {
  return (
    left.field === right.field && left.text === right.text && left.rewrittenAs === right.rewrittenAs
  );
}

/** Whether two rules are the same rule, said by the same source. */
function sameRule(left: CharterConstraint, right: CharterConstraint): boolean {
  return left.origin === right.origin && left.kind === right.kind && left.quote === right.quote;
}

/**
 * Who did what on the charter, read from its versions. Neither a strike nor an added rule carries
 * a time of its own, so each is dated by the first version in force that carries it, and an answer
 * by its own time; `actor` then says whether that was the reader or the earlier manager a later
 * handover took the employee from (`managerTransfers.earlierManagers`).
 *
 * @param versions - The employee's charter versions, in any order; undefined while they load.
 * @param actor - Who acted at a time.
 * @param fallbackAt - When the charter on the page came into force: the time for anything no
 *   version read so far carries, so a line never waits on the list to say who.
 */
export function charterActors(
  versions: readonly ActedVersion[] | undefined,
  actor: ActorAt,
  fallbackAt: number,
): CharterActors {
  const inForce = (versions ?? [])
    .filter((version) => version.approved)
    .toSorted((left, right) => inForceAt(left) - inForceAt(right));
  const firstCarrying = (carries: (body: CharterCardBody) => boolean): number =>
    firstTime(inForce, carries, fallbackAt);
  return {
    struck: (change) =>
      actor(
        firstCarrying((body) =>
          (body.struckClauses ?? []).some((kept) => sameStrike(kept, change)),
        ),
      ),
    added: (constraint) =>
      actor(
        firstCarrying((body) =>
          (body.constraints ?? []).some((rule) => sameRule(rule, constraint)),
        ),
      ),
    answered: (entry) => {
      const at = Date.parse(entry.answeredAt);
      return actor(
        Number.isNaN(at)
          ? firstCarrying((body) =>
              (body.answeredQuestions ?? []).some(
                (kept) => kept.question === entry.question && kept.answer === entry.answer,
              ),
            )
          : at,
      );
    },
  };
}

/** The time the first version in force that carries something came into force, or the fallback. */
function firstTime(
  inForce: readonly ActedVersion[],
  carries: (body: CharterCardBody) => boolean,
  fallbackAt: number,
): number {
  const first = inForce.find((version) => carries(bodyOf(version)));
  return first === undefined ? fallbackAt : inForceAt(first);
}
