import { describe, expect, it } from 'vitest';
import { characterCount, clipCharacters, withoutInvisibles } from '../../../src/lib/visible-text';

describe('withoutInvisibles', (): void => {
  it('removes control, bidirectional and zero-width characters and keeps line feeds and tabs', (): void => {
    expect(withoutInvisibles('a\u0000b\u0007c\u001Bd\u007Fe\u0085f')).toBe('abcdef');
    expect(withoutInvisibles('pay‮gnp.exe ⁦x⁩ ‎y‏ ؜z')).toBe('paygnp.exe x y z');
    expect(withoutInvisibles('a​b‌c‍d⁠e﻿f᠎g⁢h')).toBe('abcdefgh');
    expect(withoutInvisibles('one\r\ntwo\tthree')).toBe('one\ntwo\tthree');
  });

  it('leaves visible text, emoji and other scripts as they are', (): void => {
    expect(withoutInvisibles('Maya Lim, 林美雅 \u{1F431}')).toBe('Maya Lim, 林美雅 \u{1F431}');
  });
});

describe('characterCount and clipCharacters', (): void => {
  it('count a character outside the basic plane as one', (): void => {
    expect(characterCount('\u{1F431}'.repeat(3))).toBe(3);
    expect('\u{1F431}'.repeat(3).length).toBe(6);
  });

  it('clip by character and never split a surrogate pair', (): void => {
    expect(clipCharacters(`a${'\u{1F431}'.repeat(3)}`, 2)).toBe('a\u{1F431}');
    expect(clipCharacters('abc', 10)).toBe('abc');
  });
});
