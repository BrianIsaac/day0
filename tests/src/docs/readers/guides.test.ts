import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** A guide under `docs/running`, on one line, as a quoted reason reads once its wrap is undone. */
function guide(name: string): string {
  return readFileSync(new URL(`../../../../docs/running/${name}`, import.meta.url), 'utf8').replace(
    /\s+/g,
    ' ',
  );
}

/** Each reader's reasons and refusals, as its own tests pin them, that its guide quotes whole. */
const QUOTED: Readonly<Record<string, readonly string[]>> = {
  'reader-confluence.md': [
    'Confluence gave no body in its storage format for "Quarter board", so Day0 does not read it.',
    "Confluence refused the API token this source uses (HTTP 401): it may have expired (a token lasts a year at most) or been revoked. Ask IT to create a new API token for the service account with the scopes reader-confluence.md lists, then use Rotate on the source's row to enter it.",
    'Confluence refused this request for the service account (HTTP 403): ask IT to check that its API token has the scopes reader-confluence.md lists (read:space:confluence and read:page:confluence), that the service account has access to Confluence, and that it may view the space.',
    'Confluence found no space with the key "OPS" that the service account may view: check the key, and ask IT to give the service account View permission in the space.',
    "Confluence refused the personal access token this source uses (HTTP 401): it may have expired or been revoked. Ask the person it belongs to to create a new one in Confluence (their profile picture, Settings, Personal access tokens), then use Rotate on the source's row to enter it.",
    "Confluence refused this request for the token's owner (HTTP 403): ask a space administrator to give that person View permission in the space OPS.",
  ],
  'reader-sharepoint.md': [
    '"Q3 board deck.pptx" is a slide deck, which Day0 does not read: from a SharePoint library it reads Markdown files, Word documents (.docx) and the site\'s own pages.',
    '"full-crm-export.md" is 5 MiB, larger than the 2 MiB Day0 reads of one file.',
    '"Policy binder.docx" is 40 MiB, larger than the 16 MiB Day0 reads of one Word document.',
    '"Escalation paths.docx" is not read: it is not a .docx file Day0 can open: it may be protected with a password, or be an older .doc saved under the newer name.',
    '"Escalation paths.docx" has no text Day0 can read: it may hold only pictures.',
    "Microsoft refused the app registration this source reads as (invalid_client, AADSTS7000215): its client secret may have expired or been replaced. Ask IT for the registration's tenant ID, client ID and current client secret, then use Rotate on the source's row to enter them as tenant ID:client ID:client secret.",
    "Microsoft Graph refused the app this call (HTTP 403, accessDenied): reading the site's document library needs the application permission Files.Read.All, or Sites.Read.All, with admin consent. Ask IT to check the app registration against reader-sharepoint.md; where it was given Sites.Selected alone, ask them to confirm the site was granted to the app, or to grant Sites.Read.All.",
  ],
  'reader-yuque.md': [
    '"Q3 numbers" is a Yuque sheet, which Day0 does not read: only documents are read.',
    "Yuque refused the token this source uses (HTTP 401): it may have been revoked, or the paid plan that gives API tokens may have lapsed. Ask the token's owner to create a new one in Yuque's account settings, with read access to repositories and documents, then use Rotate on the source's row to enter it.",
    "Yuque refused this request for the token's owner (HTTP 403): ask a repository administrator to give that account read access to revops/runbooks, and check the token's scope lets it read repositories and documents.",
    "Yuque found no repository at acme.yuque.com/revops/nowhere that the token's owner may read (HTTP 404): check the address. To change it, unlink the source and link it again.",
  ],
  'reader-drive.md': [
    '"Full CRM export" is larger than the 10 MB Google exports, so Day0 does not read it.',
    '"Q3 board deck" is a slide deck, which Day0 does not read: from a Google Drive folder it reads Google Docs and Word documents (.docx).',
    'Google Drive found no folder at this address that the service account may read (HTTP 404): share the folder with day0-reader@acme-docs.iam.gserviceaccount.com as a Viewer, and check the address. To change the address, unlink the source and link it again.',
    "Google Drive refused this request (HTTP 403, accessNotConfigured): the Google Drive API is not enabled in the service account's Google Cloud project. Ask IT to enable it there (APIs and services, Library, Google Drive API).",
  ],
};

describe("wave 15's reader guides", (): void => {
  it.each(Object.keys(QUOTED))(
    '%s quotes word for word the reasons and refusals its reader gives',
    (name): void => {
      const text = guide(name).replaceAll('` `', ' ');
      for (const sentence of QUOTED[name]) expect(text, sentence).toContain(sentence);
    },
  );

  it.each(Object.keys(QUOTED))(
    '%s says the reader was built against the published reference and has read no tenant yet',
    (name): void => {
      const text = guide(name);
      expect(text).toMatch(/published (reference|API specification)/);
      expect(text).toContain('no tenant read yet');
    },
  );

  it('names Atlassian’s end of life for Data Center, and the unconfirmed Sites.Selected grant', (): void => {
    expect(guide('reader-confluence.md')).toContain('28 March 2029');
    const sharepoint = guide('reader-sharepoint.md');
    expect(sharepoint).toContain('Sites.Selected');
    expect(sharepoint).toContain('to be confirmed on the first tenant');
    for (const permission of ['Sites.Read.All', 'Files.Read.All']) {
      expect(sharepoint).toContain(permission);
    }
  });
});
