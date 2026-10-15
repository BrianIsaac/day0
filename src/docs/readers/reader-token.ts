/**
 * The access token one batch of a contract reader reads with (X-1 (a), the readers' half of
 * 17-X's F3): the one an earlier batch of the same sync handed back, while it serves, else a new
 * one from the provider, which the batch then hands back for the next.
 *
 * A token handed in that the provider refuses (revoked, or lapsed early) is asked for again once,
 * and the request it refused is sent again; a refusal of a token this batch asked for itself is
 * the provider's answer, worded by the reader as before. No token is ever put in a log line, a
 * cursor or a reason: the one line this module logs names the provider and the source alone.
 */
import { log } from '../../lib/logger';
import { readerTokenServes, type ReaderToken } from './batch';

/** A token as its provider issued it, with the expiry it named where it named one. */
export interface IssuedToken {
  readonly token: string;
  /** When it lapses, in epoch milliseconds; absent where the provider named no lifetime. */
  readonly expiresAt?: number;
}

/**
 * A token the provider issued now, with its expiry read from the lifetime it named.
 *
 * @param token - The access token.
 * @param expiresIn - The provider's `expires_in`: seconds, as a number or a string of digits.
 * @param now - When it was issued, in epoch milliseconds.
 * @returns The token, with an expiry where the lifetime is a positive number of seconds.
 */
export function issuedToken(token: string, expiresIn: unknown, now: number): IssuedToken {
  const seconds =
    typeof expiresIn === 'number'
      ? expiresIn
      : typeof expiresIn === 'string' && /^[0-9]+$/.test(expiresIn)
        ? Number(expiresIn)
        : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? { token, expiresAt: now + seconds * 1_000 }
    : { token };
}

/** What a batch's token is opened with. */
export interface BatchTokenOptions {
  /** The token an earlier batch handed back, as the sync hands it in. */
  readonly handed: ReaderToken | undefined;
  /** The reader's clock. */
  readonly now: () => number;
  /** Asks the provider for a new token. */
  readonly ask: () => Promise<IssuedToken>;
  /** The provider and the source, for the one line logged when a handed token is refused. */
  readonly provider: string;
  readonly sourceId: string;
}

/** The token one batch reads with, and the one it hands back. */
export class BatchToken {
  private current: string;
  private issued: IssuedToken | undefined;
  private wasHanded: boolean;
  private renewed = false;
  private readonly options: BatchTokenOptions;

  private constructor(options: BatchTokenOptions, issued: IssuedToken | undefined) {
    this.options = options;
    this.issued = issued;
    this.wasHanded = issued === undefined;
    this.current = issued?.token ?? options.handed?.token ?? '';
  }

  /**
   * The token a batch begins with: the handed one while it serves, else a new one.
   *
   * @throws What asking the provider throws, worded by the reader.
   */
  static async open(options: BatchTokenOptions): Promise<BatchToken> {
    const { handed, now } = options;
    if (handed !== undefined && handed.token !== '' && readerTokenServes(handed, now())) {
      return new BatchToken(options, undefined);
    }
    return new BatchToken(options, await options.ask());
  }

  /** The token to send as the bearer. */
  get bearer(): string {
    return this.current;
  }

  /**
   * Ask for a new token in place of a handed one the provider refused.
   *
   * @returns Whether there is a new token to send the refused request with again: false where
   *   the refused token was this batch's own, so the refusal is the provider's answer.
   * @throws What asking the provider throws, worded by the reader.
   */
  async renew(): Promise<boolean> {
    if (!this.wasHanded) return false;
    log.info('documentation reader token refused; asking for another', {
      provider: this.options.provider,
      sourceId: this.options.sourceId,
    });
    const issued = await this.options.ask();
    this.issued = issued;
    this.current = issued.token;
    this.wasHanded = false;
    this.renewed = true;
    return true;
  }

  /**
   * The token to hand back beside the batch's cursor: the one this batch asked for, where its
   * provider named when it lapses. None where the batch read with the handed one, which the sync
   * keeps, or the provider named no lifetime, so the next batch asks again. A renewal with no
   * lifetime hands its token back as lapsing now: none would leave the sync the refused token,
   * and each later batch would be refused it once more before asking again.
   */
  handBack(): ReaderToken | undefined {
    const issued = this.issued;
    if (issued === undefined) return undefined;
    if (issued.expiresAt !== undefined) return { token: issued.token, expiresAt: issued.expiresAt };
    return this.renewed ? { token: issued.token, expiresAt: this.options.now() } : undefined;
  }
}
