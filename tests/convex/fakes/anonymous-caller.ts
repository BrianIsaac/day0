/**
 * The anonymous-caller guard's refusal (`getCallerOrThrow`, 12-G), as a test matches a rejected
 * call against it: the not-authenticated `ConvexError` in the deployment's words, read after the
 * test has set the mode, since no-auth mode words it at length.
 */
export async function guardRefusal(): Promise<{ readonly data: string }> {
  const { notAuthenticatedMessage } = await import('../../../convex/devAuth');
  return { data: notAuthenticatedMessage() };
}
