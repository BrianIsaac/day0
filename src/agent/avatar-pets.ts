import { fnv1a32 } from '../lib/short-hash';

// The pixel-art faces are not ours. They come from the public "Singapore
// Codex Pets" community gallery, credited with its licence terms in the
// README's Credits section and in NOTICE. The product names no person: each
// face is known by its number only (decision N6).

/** How many faces the gallery holds. */
const FACE_COUNT = 29;

/** One selectable agent face. */
export interface AgentAvatarPet {
  readonly id: string;
  /** The face's accessible name, `Face n`. */
  readonly label: string;
  readonly src: string;
}

/** Every face an agent can wear, in the picker's order. */
export const SINGAPORE_AI_BUILDER_AVATARS: readonly AgentAvatarPet[] = Array.from(
  { length: FACE_COUNT },
  (_, index): AgentAvatarPet => face(index + 1),
);

/** The face a new agent starts with. */
export const DEFAULT_AGENT_AVATAR = SINGAPORE_AI_BUILDER_AVATARS[0]!;

function face(number: number): AgentAvatarPet {
  const id = `face-${String(number).padStart(2, '0')}`;
  return { id, label: `Face ${number}`, src: `/agent-avatars/faces/${id}.webp` };
}

/**
 * The face stored under an avatar id.
 *
 * An id this build does not list, such as one stored by an earlier build that
 * keyed faces by a person's handle, gets a stable face chosen by its digest, so
 * the same row always shows the same face and no handle is needed to find it.
 *
 * @returns The listed face, the digest's face for an unknown id, or the
 *   default face when there is no id.
 */
export function avatarById(id: string | undefined): AgentAvatarPet {
  if (id === undefined || id === '') return DEFAULT_AGENT_AVATAR;
  return (
    SINGAPORE_AI_BUILDER_AVATARS.find((avatar) => avatar.id === id) ??
    SINGAPORE_AI_BUILDER_AVATARS[fnv1a32(id) % FACE_COUNT]!
  );
}
