'use client';

import { useEffect } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { errorMessage } from '@/lib/errors';
import { log } from '@/lib/logger';

/**
 * Ask the backend, each time the signed-in home opens, to keep the owner's own person in their
 * people graph (`people.ensureOwner`, wave 13): the server learns the owner's verified address
 * only from a signed-in call, so this is where the graph's owner row is first written for every
 * owner from before it, and kept up to date after. The backend writes nothing in mock mode or for
 * an unverified address, and nothing it already holds, so a repeat costs one small read.
 */
export function useOwnerPerson(): void {
  const ensureOwner = useMutation(api.people.ensureOwner);
  useEffect(() => {
    // The chain ends in its own catch: a refusal is logged and the page goes on, since nothing on
    // it waits for the owner's person.
    void ensureOwner({}).catch((err: unknown): void => {
      log.warn("the owner's own person was not kept", { reason: errorMessage(err) });
    });
  }, [ensureOwner]);
}
