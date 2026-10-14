/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The one reader of `.env.local` (W17-R24): IT writes the file as a shell file is written, and
 * `docker compose` and Next read it as dotenv does, so every script that reads it reads it the
 * same way. `pnpm dev` and `pnpm start`, the setup's verbs and the checks, `check:setup` and the
 * sync script (through {@link main}) all read it here.
 */

/** A declaration: an optional `export`, a name, `=`, and the rest of the line. */
const DECLARATION = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** The quotes a value may be written in. */
const QUOTES = new Set(['"', "'", '`']);

/**
 * The value a quoted declaration holds from `rest`, the text after its opening quote, and the
 * lines after it for a value the quote carries over more than one: the text up to the matching
 * quote, a double-quoted value with `\n`, `\r` and `\"` read as dotenv reads them, a single- or
 * back-quoted one as written. Undefined when no line closes the quote.
 */
function quotedValue(
  quote: string,
  rest: string,
  following: readonly string[],
): { value: string; lines: number } | undefined {
  let text = rest;
  for (let taken = 0; ; taken += 1) {
    for (let index = 0; index < text.length; index += 1) {
      if (quote === '"' && text[index] === '\\') {
        index += 1;
        continue;
      }
      if (text[index] !== quote) continue;
      const inner = text.slice(0, index);
      const value =
        quote === '"'
          ? inner.replace(/\\(["nr])/g, (_escape, letter: string) =>
              letter === 'n' ? '\n' : letter === 'r' ? '\r' : '"',
            )
          : inner;
      return { value, lines: taken };
    }
    const next = following[taken];
    if (next === undefined) return undefined;
    text = `${text}\n${next}`;
  }
}

/**
 * An unquoted value as written: up to a `#` that follows a space or a tab, which opens a comment
 * as compose reads it ("a#b" keeps its `#`), trimmed; a value that opens on `#` is none.
 */
function unquotedValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('#')) return '';
  return value.replace(/[ \t]+#.*$/, '').trim();
}

/**
 * Every name an env file's text declares, with its value as dotenv reads it: an `export` before
 * the name is the shell's and no part of it; a value in single, double or back quotes is the
 * text inside them, the double-quoted with its escapes read; an unquoted value ends at a comment;
 * a line break is `\n`, `\r\n` or `\r`; and a name declared twice holds its last value, as compose
 * and Next take it. A line that declares nothing (a comment, a blank) is passed over, and so is
 * the byte order mark an editor may write first. An empty value is kept as empty, so a caller can
 * tell a name set to nothing from one never named.
 *
 * @param text - The file's text.
 * @returns Each declared name and its value, in the order first declared.
 */
export function parseEnvText(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = DECLARATION.exec(lines[index]!);
    if (match === null) continue;
    const [, name, raw] = match as unknown as [string, string, string];
    const quote = raw[0];
    const quoted =
      quote !== undefined && QUOTES.has(quote)
        ? quotedValue(quote, raw.slice(1), lines.slice(index + 1))
        : undefined;
    if (quoted !== undefined) {
      values.set(name, quoted.value);
      index += quoted.lines;
      continue;
    }
    values.set(name, unquotedValue(raw));
  }
  return values;
}

/**
 * Every name an env file declares, read by {@link parseEnvText}.
 *
 * @param path - The env file's path.
 * @returns The declared values; empty when the file does not exist.
 */
export function readEnvFileValues(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(parseEnvText(readFileSync(path, 'utf8')));
}

/**
 * The file's values as the sync script reads them, one `NAME=value` a line: a shell cannot read
 * the file as dotenv does, so it asks this reader once. A value that spans lines is refused by
 * name, never printed, since one line a name is all the script's reader takes.
 *
 * @param path - The env file's path.
 * @returns The lines to print, or the refusal.
 */
export function envFileLines(path: string): { lines: string[] } | { refused: string } {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(readEnvFileValues(path))) {
    if (/[\r\n]/.test(value)) {
      return {
        refused: `${name} in ${path} holds a line break, which no setting Day0 reads takes.`,
      };
    }
    lines.push(`${name}=${value}`);
  }
  return { lines };
}

/** `tsx scripts/lib/env-text.ts <file>`: print the file's values for the sync script. */
function main(): void {
  const path = process.argv[2] ?? '.env.local';
  const read = envFileLines(path);
  if ('refused' in read) {
    process.stderr.write(`error: ${read.refused}\n`);
    process.exit(1);
  }
  if (read.lines.length > 0) process.stdout.write(`${read.lines.join('\n')}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
