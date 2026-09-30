/**
 * The height the Day-1 1:1 occupies, in the chat room and the voice room
 * alike, and in the placeholder the dashboard shows while either room's chunk
 * loads: the page does not jump when a room lands or the manager switches.
 * The notice a deployment without voice credentials shows is sized to its text.
 *
 * Sized to the viewport, never past 40rem (the progress line, a labelled composer and about six
 * turns of the transcript). From `md`, where the first-week rail is one row, the room starts
 * about 23rem down the page (369 px under the header, the breadcrumb, the name and the rail, on
 * the 30 September bed), so it takes what is left of the window and the reply box is in view on
 * the room's first view down to a 720 px window (the hosted walk's m9: at 1440 x 900 a fixed
 * 40rem put it at y 864). Below `md` the rail stacks and the room starts some 37rem down, too far
 * for anything to fit beside it, so the room is one window tall under the sticky header instead:
 * scrolled to, its progress, transcript and composer are in view together. 20rem is the floor
 * that still holds a turn above the composer.
 */
export const ROOM_HEIGHT =
  'h-[clamp(20rem,calc(100dvh-5.5rem),40rem)] md:h-[clamp(20rem,calc(100dvh-24.5rem),40rem)]';
