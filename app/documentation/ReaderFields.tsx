import { INPUT_CLASS } from '../components/Field';
import { HELP, LABEL } from './field-classes';
import { READER_GUIDE_URLS, type ReaderKind } from './reader-link';

/** One field a reader kind adds to the link form. */
interface ReaderField {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
  readonly placeholder?: string;
}

/** The fields each kind asks for beside its location: what its reader's secret is made of. */
const FIELDS: Readonly<Record<ReaderKind, readonly ReaderField[]>> = {
  sharepoint: [
    { id: 'reader-tenant-id', name: 'tenantId', label: 'Tenant ID', secret: false },
    { id: 'reader-client-id', name: 'clientId', label: 'Client ID', secret: false },
    { id: 'reader-client-secret', name: 'clientSecret', label: 'Client secret', secret: true },
  ],
  'confluence-v2': [
    {
      id: 'reader-cloud-id',
      name: 'cloudId',
      label: 'Cloud ID',
      secret: false,
      placeholder: '1a11d016-8984-4c3e-b9ab-142dd06acb1b',
    },
    { id: 'reader-token', name: 'credential', label: 'API token', secret: true },
  ],
  'confluence-dc': [
    { id: 'reader-token', name: 'credential', label: 'Personal access token', secret: true },
  ],
  yuque: [{ id: 'reader-token', name: 'credential', label: 'Token', secret: true }],
  drive: [
    {
      id: 'reader-key',
      name: 'credential',
      label: 'Service account key',
      secret: true,
      placeholder: "Paste the JSON key file's contents",
    },
  ],
};

/** What each kind's secret is, who made it, and where it is sent. */
const SECRET_HELP: Readonly<Record<ReaderKind, string>> = {
  sharepoint:
    'The three values of the app registration IT made for day0. The secret is encrypted when submitted, sent only to Microsoft, and never displayed again.',
  'confluence-v2':
    "A service account's API token and the site's cloud ID, which IT reads from admin.atlassian.com. The token is encrypted when submitted, sent only to Atlassian, and never displayed again.",
  'confluence-dc':
    'A personal access token of an account that may view the space. It is encrypted when submitted, sent only to your Confluence server, and never displayed again.',
  yuque:
    'A Yuque token, which needs a paid plan. It is encrypted when submitted, sent only to Yuque, and never displayed again.',
  drive:
    "The JSON key of a service account the folder is shared with. It is encrypted when submitted, used only to sign day0's requests to Google, and never displayed again.",
};

/** What each kind reaches, in the words the kind help uses. */
const REACHES: Readonly<Record<ReaderKind, string>> = {
  sharepoint: 'this site through Microsoft Graph, as the app registration IT made',
  'confluence-v2': "this space through Atlassian's gateway, as a service account",
  'confluence-dc': "this space through your server's REST API, with a personal access token",
  yuque: "this repository through Yuque's API, with a token",
  drive: 'this folder through the Google Drive API, as a service account',
};

/**
 * The fields one of wave 15's reader kinds adds to the link form: what its reader's secret is
 * made of. Uncontrolled, so the form's reset clears every secret once the source is linked.
 *
 * @param props - The selected kind.
 */
export function ReaderCredentialFields(props: { kind: ReaderKind }): React.ReactNode {
  const fields = FIELDS[props.kind];
  return (
    <div className="grid gap-4">
      <div className={`grid gap-4 ${fields.length > 1 ? 'sm:grid-cols-2' : ''}`}>
        {fields.map((each) => (
          <div key={each.id} className="grid gap-1.5">
            <label htmlFor={each.id} className={LABEL}>
              {each.label}
            </label>
            <input
              id={each.id}
              name={each.name}
              type={each.secret ? 'password' : 'text'}
              autoComplete={each.secret ? 'new-password' : 'off'}
              spellCheck={false}
              required
              placeholder={each.placeholder}
              aria-describedby="reader-secret-help"
              className={`${INPUT_CLASS} w-full`}
            />
          </div>
        ))}
      </div>
      <p id="reader-secret-help" className={HELP}>
        {SECRET_HELP[props.kind]}
      </p>
    </div>
  );
}

/**
 * What one of wave 15's reader kinds reaches, that nothing of day0's has to be running for it,
 * and where IT's guide to its credential is.
 *
 * @param props - The selected kind.
 */
export function ReaderKindHelp(props: { kind: ReaderKind }): React.ReactNode {
  return (
    <p className={HELP}>
      The backend reads {REACHES[props.kind]}. No day0 component has to be running.{' '}
      <a href={READER_GUIDE_URLS[props.kind]} target="_blank" rel="noreferrer">
        How IT sets it up
      </a>
      .
    </p>
  );
}
