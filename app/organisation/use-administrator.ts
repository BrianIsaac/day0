'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';

/** The account menu's way to the organisation page, as its link says it. */
export const ORGANISATION_LINK = 'Organisation';

/** The organisation page's address. */
export const ORGANISATION_HREF = '/organisation';

/**
 * Whether the signed-in person is one of the deployment's administrators (B8), for showing the
 * organisation page's way in only: `summaryForManager`'s answer, asked once Convex holds a token,
 * since the query refuses a caller with none. False while it is read and for anyone else; the
 * page and its functions refuse a non-administrator themselves.
 */
export function useCallerIsAdministrator(): boolean {
  const { isAuthenticated } = useConvexAuth();
  const summary = useQuery(
    api.organisationConnections.summaryForManager,
    isAuthenticated ? {} : 'skip',
  );
  return summary?.callerIsAdministrator === true;
}
