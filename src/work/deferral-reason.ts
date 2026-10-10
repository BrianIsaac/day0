/**
 * The reason a work item parked for a missing permission carries (RM12 (c), the Q3 re-run's
 * call): a sentence the manager reads, naming the permission, where the row held only the
 * verdict's code and its `missingPermissions` list.
 */

/**
 * The reason of a deferral that waits on permissions the employee does not hold, or undefined when
 * the verdict names none. The verdict is stored unvalidated, so anything but a list of names
 * yields no reason rather than a sentence with a hole in it.
 *
 * @param verdict - The deferral's verdict, as the evaluation wrote it.
 * @param employeeName - The employee the work is parked on.
 */
export function permissionDeferralReason(
  verdict: { readonly missingPermissions?: unknown },
  employeeName: string,
): string | undefined {
  const named = Array.isArray(verdict.missingPermissions) ? verdict.missingPermissions : [];
  const scopes = [
    ...new Set(
      named.filter((scope): scope is string => typeof scope === 'string' && scope.trim() !== ''),
    ),
  ];
  if (scopes.length === 0) return undefined;
  const one = scopes.length === 1;
  const listed = one
    ? scopes[0]
    : `${scopes.slice(0, -1).join(', ')} and ${scopes[scopes.length - 1]}`;
  return `Deferred: this work needs ${listed}, ${one ? 'a permission' : 'permissions'} ${employeeName} does not hold. It is evaluated again once you grant ${one ? 'it' : 'them'}.`;
}
