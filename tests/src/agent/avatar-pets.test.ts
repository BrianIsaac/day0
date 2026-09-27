import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_AVATAR,
  SINGAPORE_AI_BUILDER_AVATARS,
  avatarById,
} from '../../../src/agent/avatar-pets';

const PUBLIC = fileURLToPath(new URL('../../../public', import.meta.url));
const AVATARS = fileURLToPath(new URL('../../../public/agent-avatars', import.meta.url));

describe('agent faces', () => {
  it('names each face by its number and carries no other field', () => {
    SINGAPORE_AI_BUILDER_AVATARS.forEach((avatar, index) => {
      const number = index + 1;
      expect(avatar).toEqual({
        id: `face-${String(number).padStart(2, '0')}`,
        label: `Face ${number}`,
        src: `/agent-avatars/faces/face-${String(number).padStart(2, '0')}.webp`,
      });
    });
    expect(SINGAPORE_AI_BUILDER_AVATARS).toHaveLength(29);
  });

  it('serves every face from a file that exists', () => {
    for (const avatar of SINGAPORE_AI_BUILDER_AVATARS) {
      expect(existsSync(`${PUBLIC}${avatar.src}`), avatar.src).toBe(true);
    }
  });

  it('ships no avatar file named for anything but a face number', () => {
    const files = readdirSync(AVATARS, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(files).toHaveLength(29);
    expect(files.filter((name) => !/^face-\d{2}\.webp$/.test(name))).toEqual([]);
  });
});

describe('avatarById', () => {
  it('returns the listed face for its id', () => {
    expect(avatarById('face-07')).toBe(SINGAPORE_AI_BUILDER_AVATARS[6]);
  });

  it('returns the default face when there is no id', () => {
    expect(avatarById(undefined)).toBe(DEFAULT_AGENT_AVATAR);
    expect(avatarById('')).toBe(DEFAULT_AGENT_AVATAR);
  });

  it('gives an id it does not list the same listed face every time', () => {
    const first = avatarById('tw-an-earlier-build');
    expect(SINGAPORE_AI_BUILDER_AVATARS).toContain(first);
    expect(avatarById('tw-an-earlier-build')).toBe(first);
  });

  it('spreads unknown ids across the gallery rather than onto the default', () => {
    const faces = new Set(
      Array.from({ length: 40 }, (_, index) => avatarById(`stored-${index}`).id),
    );
    expect(faces.size).toBeGreaterThan(10);
  });
});
