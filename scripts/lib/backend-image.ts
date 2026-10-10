/*
 * How the built backend image says which base it was built from (W14-R20): the label
 * `docker/backend.Dockerfile` writes, and the arguments that read it back. A module of its own,
 * with no import, so the demo bed and `scripts/lib/docker.ts` (which imports the demo bed) both
 * read it.
 */

/**
 * The label the backend image carries: the digest of the base it was built from
 * (`docker/backend.Dockerfile`'s `LABEL`, W14-R20). The tag `day0-convex-backend:git` is one name
 * for the whole machine, re-tagged by every checkout's build, so a reader trusts the image by this
 * label, never by the tag.
 */
export const BACKEND_BASE_LABEL = 'dev.dayzer0.backend.base';

/** The digest a pinned image reference ends on (`sha256:...`), or nothing for an unpinned one. */
export function referenceDigest(reference: string | undefined): string | undefined {
  return /@(sha256:[0-9a-f]{64})$/.exec(reference ?? '')?.[1];
}

/** The base digest a backend Dockerfile labels its image with, or nothing when it has no label. */
export function dockerfileBaseLabel(text: string): string | undefined {
  const pattern = new RegExp(
    `^\\s*LABEL\\s+${BACKEND_BASE_LABEL.replace(/\./g, '\\.')}="?(sha256:[0-9a-f]{64})"?\\s*$`,
    'm',
  );
  return pattern.exec(text)?.[1];
}

/** `docker image inspect` arguments that print an image's base label, empty when it has none. */
export function baseLabelInspect(reference: string): string[] {
  return [
    'image',
    'inspect',
    reference,
    '--format',
    `{{index .Config.Labels "${BACKEND_BASE_LABEL}"}}`,
  ];
}

/**
 * The digest of the base a Dockerfile starts from: its first `FROM`, when that reference is
 * pinned by digest.
 */
export function dockerfilePinnedDigest(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    if (from) return referenceDigest(from[1]);
  }
  return undefined;
}
