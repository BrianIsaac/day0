import { describe, expect, it } from 'vitest';
import { guardReason, guardSecretSpan, splitUserPasswordPair } from '../../../src/redaction/guard';
import { NEVER_REDACT } from '../../../src/redaction/policy';
import { CORPUS_SLOTS } from '../../fixtures/redaction-corpus';

function spanOf(text: string, value: string): { start: number; end: number } {
  const start = text.indexOf(value);
  if (start === -1) throw new Error(`${value} not in ${text}`);
  return { start, end: start + value.length };
}

describe('the guard between a model span and the stored text', (): void => {
  it.each([
    ['REVOPS-7', 'issue key'],
    ['{{secret}}', 'reference'],
    ['${LOOKER_PASSWORD}', 'reference'],
    ['<password>', 'reference'],
    ['<credential: linear service token, stored>', 'reference'],
    ['PASTE_LINEAR_API_KEY_HERE', 'upper-case name'],
    ['OPENAI_API_KEY', 'upper-case name'],
    ['YOUR_TOKEN', 'upper-case name'],
    ['https://slack.com/api/', 'url'],
    ['xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'masked'],
    ['password', 'label word'],
    ['C0123456789', 'slack id'],
    ['0f8fad5b-d9cb-469f-a165-70867728950e', 'uuid'],
    ['3f2a9c1e7b5d4a6f8e0c2b1d9a7f6e5c4b3a2d1e', 'hex id'],
    ['2026-09-03', 'date'],
    ['74%', 'figure'],
    ['$45k', 'figure'],
    ['see the vault item', 'prose'],
    ['abc', 'too short'],
  ])('rejects %s as %s', (value: string, reason: string): void => {
    expect(guardReason(value)).toBe(reason);
    expect(guardSecretSpan(value, { start: 0, end: value.length }, 'access token')).toBeUndefined();
  });

  it.each(['hunter2', 'pipeline-tile-local', 'P@ssw0rd!', 'Tr0ub4dor&3', 'Sunny-Day-42', '0419', 'q7Mz2Kv9'])(
    'passes %s through',
    (value: string): void => {
      expect(guardReason(value)).toBeUndefined();
      expect(guardSecretSpan(value, { start: 0, end: value.length }, 'password')).toEqual({
        start: 0,
        end: value.length,
      });
    },
  );

  it('narrows a span that swallowed its label to the value', (): void => {
    for (const [text, value] of [
      ['Sign in with password: hunter2 and press Save.', 'hunter2'],
      ['the password is hunter2; rotate it', 'hunter2'],
      ['Looker password: `revops2026`', 'revops2026'],
      ['密码：hunter2，请勿写入工单', 'hunter2'],
    ]) {
      const swallowed = spanOf(text, text.slice(text.search(/password|密码/), spanOf(text, value).end));
      const narrowed = guardSecretSpan(text, swallowed, 'password');
      expect(narrowed).toEqual(spanOf(text, value));
    }
  });

  it('trims whitespace and enclosing punctuation and drops a span that is prose', (): void => {
    const text = 'Use (hunter2), then rotate it.';
    expect(guardSecretSpan(text, spanOf(text, ' (hunter2),'), 'password')).toEqual(spanOf(text, 'hunter2'));
    const prose = 'Session: token, valid for one hour.';
    expect(guardSecretSpan(prose, spanOf(prose, 'valid for one hour'), 'access token')).toBeUndefined();
  });

  it('keeps the whitespace of a private key block', (): void => {
    const text = 'key\nAAAA\nBBBB\nend';
    expect(guardSecretSpan(text, spanOf(text, 'AAAA\nBBBB'), 'private key')).toEqual(spanOf(text, 'AAAA\nBBBB'));
  });
});

describe('explicit password assignments', () => {
  it.each([
    ['Looker password: revops2026', 'Looker password', 'revops2026'],
    ['密码：revops2026', '密码', 'revops2026'],
    ['Password: abc', 'abc', 'abc'],
    ['Password: 123', '123', '123'],
    ['Password: revops\n2026', 'revops\n2026', 'revops\n2026'],
    ['{"message":"Looker password: revops2026\\nNext step"}', 'Looker password', 'revops2026'],
  ])('keeps the value span for %s', (text, candidate, value) => {
    expect(guardSecretSpan(text, spanOf(text, candidate), 'password')).toEqual(spanOf(text, value));
  });

  it.each(['{{secret}}', '<credential: looker password, stored>', '74%', 'https://example.test', 'REVOPS-7'])(
    'keeps working material after a label: %s', (value) => {
      const text = `Password: ${value}`;
      expect(guardSecretSpan(text, spanOf(text, 'Password'), 'password')).toBeUndefined();
    },
  );
});

it('retains base64 padding when a detected credential ends immediately before it', () => {
  const text = 'Credential: cmV2b3BzMjAyNg==';
  expect(guardSecretSpan(text, spanOf(text, 'cmV2b3BzMjAyNg'), 'credential'))
    .toEqual(spanOf(text, 'cmV2b3BzMjAyNg=='));
});

describe('label-only spans and pairs', (): void => {
  it('extends a PIN or passcode label across a short phrase to a numeric value, and stops at sentence punctuation', (): void => {
    const pin = 'PIN for the shared phone: 0419, rotated monthly';
    expect(guardSecretSpan(pin, spanOf(pin, 'PIN'), 'password')).toEqual(spanOf(pin, '0419'));
    const prose = 'The tile login is revops and the password is hunter2; the operations lead rotates it.';
    expect(guardSecretSpan(prose, spanOf(prose, 'password'), 'password')).toEqual(spanOf(prose, 'hunter2'));
    const policy = 'password policy: rotate quarterly';
    expect(guardSecretSpan(policy, spanOf(policy, 'password'), 'password')).toBeUndefined();
  });

  it('reads a user / password pair as a username and a secret', (): void => {
    expect(splitUserPasswordPair('revops / hunter2')).toEqual({ username: 'revops', password: 'hunter2' });
    expect(splitUserPasswordPair('revops/Sunny-Day-42')).toEqual({ username: 'revops', password: 'Sunny-Day-42' });
    expect(splitUserPasswordPair('docs / runbooks / archive')).toBeUndefined();
    expect(splitUserPasswordPair('Looker tile')).toBeUndefined();
    expect(splitUserPasswordPair('revops / {{secret}}')).toBeUndefined();
  });
});

describe('working material the model mistakes for a secret', (): void => {
  it.each([
    ['sk-test', 'placeholder'],
    ['pk_live', 'placeholder'],
    ['bastion.acme.internal', 'hostname'],
    ['db.internal.acme.example', 'hostname'],
    ['revops-7-refresh-the-looker-pipeline-tile', 'branch name'],
    ['username', 'label word'],
    ['Username', 'label word'],
    ['user', 'label word'],
    ['{{secret}}', 'reference'],
  ])('rejects %s as %s', (value: string, reason: string): void => {
    expect(guardReason(value)).toBe(reason);
  });

  it.each(['hunter2.local1', 'Sunny-Day-42', 'pipeline-tile-local', 'warehouse-read-only', 'sk-test-9Xq2', 'q7Mz2Kv9'])(
    'still passes %s',
    (value: string): void => {
      expect(guardReason(value)).toBeUndefined();
    },
  );

  it('keeps a value a username designator introduces and a value under an identifier key', (): void => {
    const prose = 'The tile login is revops and the password is hunter2.';
    expect(guardSecretSpan(prose, spanOf(prose, 'revops'), 'api key')).toBeUndefined();
    expect(guardSecretSpan(prose, spanOf(prose, 'hunter2'), 'password')).toEqual(spanOf(prose, 'hunter2'));
    const labelled = 'username: revops, password: Tr0ub4dor&3';
    expect(guardSecretSpan(labelled, spanOf(labelled, 'revops'), 'credential')).toBeUndefined();
    expect(guardSecretSpan(labelled, spanOf(labelled, 'Tr0ub4dor&3'), 'credential')).toEqual(spanOf(labelled, 'Tr0ub4dor&3'));
    const record = '{"id":"iss-9Xq2","identifier":"REVOPS-7","token":"Tr0ub4dor&3","url":"https://x.example/a"}';
    expect(guardSecretSpan(record, spanOf(record, 'iss-9Xq2'), 'access token')).toBeUndefined();
    expect(guardSecretSpan(record, spanOf(record, 'Tr0ub4dor&3'), 'access token')).toEqual(spanOf(record, 'Tr0ub4dor&3'));
  });

  it('never redacts a value on the policy list', (): void => {
    for (const value of NEVER_REDACT) {
      expect(guardReason(value), value).toBeDefined();
      expect(guardSecretSpan(`token: ${value}`, { start: 7, end: 7 + value.length }, 'access token')).toBeUndefined();
    }
  });
});


it.each(['channels:history', 'im:write', 'im:history', 'users:read.email', 'linear:read', 'slack:write', 'repo:status', 'verbs:get'])(
  'keeps scope %s and partial spans in scope lists', (value) => {
    for (const text of [`["${value}"]`, `'${value}', 'other:read'`, `Use \`${value}\``, `${value}, other:read`]) {
      expect(guardSecretSpan(text, spanOf(text, value), 'credential')).toBeUndefined();
      const tail = value.split(':')[1];
      expect(guardSecretSpan(text, spanOf(text, tail), 'credential')).toBeUndefined();
    }
    expect(guardReason(value)).toBe('permission scope');
  },
);

it('keeps a scope-shaped value under an explicit password or secret assignment as the credential', () => {
  for (const [text, value, label] of [
    ["password: 'ops:hunter2'", 'ops:hunter2', 'password'],
    ['Looker password: `tile:q3close`', 'tile:q3close', 'password'],
    ['token: "svc:hunter2"', 'svc:hunter2', 'credential'],
    ['PIN = "door:4412"', 'door:4412', 'password'],
  ] as const) {
    expect(guardSecretSpan(text, spanOf(text, value), label), text).toEqual(spanOf(text, value));
  }
  expect(guardReason('ops:hunter2')).toBe('permission scope');
  expect(guardReason('ops:hunter2', { assigned: true })).toBeUndefined();
  expect(guardReason('users:read.email', { assigned: true })).toBeUndefined();
  expect(guardReason('<password>', { assigned: true })).toBe('reference');
  // A scope in a list stays a scope whatever a nearby label says about the list.
  const listed = 'scopes: ["chat:write", "users:read"]';
  expect(guardSecretSpan(listed, spanOf(listed, 'chat:write'), 'credential')).toBeUndefined();
});

it('keeps long and versioned permission identifiers without treating opaque halves as scopes', () => {
  for (const value of ['organization:read_all_repository_members_and_permissions', 'version2026:read']) {
    const text = `["${value}"]`;
    expect(guardSecretSpan(text, spanOf(text, value), 'credential')).toBeUndefined();
    expect(guardReason(value)).toBe('permission scope');
  }
  for (const value of ['scope:a1b2c3d4e5f6g7h8', 'scope:q7mz2kv9r5tp8wn4', 'scope:qwertyuiopasdfghj', 'scope:123456789', 'scope:MixedCase9Token']) {
    const text = `["${value}"]`;
    expect(guardSecretSpan(text, spanOf(text, value), 'credential')).toEqual(spanOf(text, value));
    expect(guardReason(value)).toBeUndefined();
  }
});

describe('structural identifiers the deployed model took for tokens on 18 September', (): void => {
  it.each([
    ['#ops-requests', 'channel reference'],
    ['#revops-asks', 'channel reference'],
    ['#finance_close-2026', 'channel reference'],
    ['users.lookupByEmail', 'dotted identifier'],
    ['chat.postMessage', 'dotted identifier'],
    ['admin.conversations.ekm.listOriginalConnectedChannelInfo', 'dotted identifier'],
    ['process.env.HOME', 'dotted identifier'],
    ['README.md', 'dotted identifier'],
  ])('rejects %s as %s wherever it sits without a credential label', (value: string, reason: string): void => {
    expect(guardReason(value)).toBe(reason);
    for (const text of [`Use \`${value}\` for that.`, `${value}, then the rest`, `(${value})`, `| ${value} | all teams |`]) {
      expect(guardSecretSpan(text, spanOf(text, value), 'access token'), text).toBeUndefined();
    }
  });

  it('rejects an all-lowercase method name by the hostname shape, which comes first', (): void => {
    for (const value of ['auth.test', 'oauth.v2.access', 'conversations.history']) {
      expect(guardReason(value), value).toBe('hostname');
      const text = `Methods automations use: \`${value}\`, then the rest.`;
      expect(guardSecretSpan(text, spanOf(text, value), 'access token'), value).toBeUndefined();
    }
  });

  it('rejects a bare camelCase identifier the way it rejects a snake_case one, outside an assignment', (): void => {
    for (const value of ['lookupByEmail', 'postMessage', 'save_comment']) {
      const listed = `Call \`${value}\` first.`;
      expect(guardSecretSpan(listed, spanOf(listed, value), 'access token'), value).toBeUndefined();
      const labelled = `token: ${value}`;
      expect(guardSecretSpan(labelled, spanOf(labelled, value), 'access token'), value).toEqual(spanOf(labelled, value));
    }
  });

  it('rejects a partial span of either: the name without its hash, one segment of a method', (): void => {
    const channel = 'Requests arrive in `#ops-requests` and `#revops`.';
    expect(guardSecretSpan(channel, spanOf(channel, 'ops-requests'), 'access token')).toBeUndefined();
    const method = 'Call `users.lookupByEmail` first, then `conversations.open`.';
    expect(guardSecretSpan(method, spanOf(method, 'lookupByEmail'), 'access token')).toBeUndefined();
    expect(guardSecretSpan(method, spanOf(method, 'conversations'), 'access token')).toBeUndefined();
  });

  it('keeps every token-shaped value, dots and digits included, with or without a label', (): void => {
    for (const value of [
      CORPUS_SLOTS.slack_bot_token,
      CORPUS_SLOTS.linear_token,
      CORPUS_SLOTS.client_secret,
      CORPUS_SLOTS.jwt,
      ['q7Mz', '2Kv9', 'Tx4W'].join('.'),
      '#Summer2026!',
      'hunter2.local1',
    ]) {
      expect(guardReason(value), value).toBeUndefined();
      expect(guardReason(value, { assigned: true }), value).toBeUndefined();
      const text = `Use \`${value}\` for that.`;
      expect(guardSecretSpan(text, spanOf(text, value), 'access token'), value).toEqual(spanOf(text, value));
    }
  });

  it('keeps a labelled secret that has the shape of a channel or a dotted name', (): void => {
    const dotted = ['Ops', 'Desk', 'Winter'].join('.');
    expect(guardReason(dotted)).toBe('dotted identifier');
    expect(guardReason(dotted, { assigned: true })).toBeUndefined();
    expect(guardReason('#summer2026')).toBe('channel reference');
    expect(guardReason('#summer2026', { assigned: true })).toBeUndefined();
    for (const [text, value, label] of [
      [`Looker password: \`${dotted}\``, dotted, 'password'],
      [`password = ${dotted}`, dotted, 'password'],
      ['token: "#summer2026"', '#summer2026', 'credential'],
      [`Slack bot token: ${CORPUS_SLOTS.slack_bot_token}`, CORPUS_SLOTS.slack_bot_token, 'access token'],
    ] as const) {
      expect(guardSecretSpan(text, spanOf(text, value), label), text).toEqual(spanOf(text, value));
    }
    // A label that swallowed the value narrows to it and still keeps it.
    const swallowed = `password: ${dotted}`;
    expect(guardSecretSpan(swallowed, { start: 0, end: swallowed.length }, 'password')).toEqual(spanOf(swallowed, dotted));
  });

  it('keeps a name-shaped token in a credential table column', (): void => {
    const value = ['#', 'cobalt', 'harbor'].join('');
    const table = `| Service | Service token |\n|---|---|\n| Bot | ${value} |`;
    expect(guardSecretSpan(table, spanOf(table, value), 'access token')).toEqual(spanOf(table, value));
  });

  it('keeps a lowercase dotted password when its label assigns it explicitly', (): void => {
    const value = ['winter', 'spring'].join('.');
    const text = `Password: ${value}`;
    expect(guardSecretSpan(text, spanOf(text, value), 'password')).toEqual(spanOf(text, value));
    expect(guardReason(value)).toBe('hostname');
    expect(guardReason(value, { assigned: true })).toBeUndefined();
  });

  it('keeps the full assigned secret when a span covers only its part after a hash or dot', (): void => {
    const hashed = ['#', 'cobalt-harbor'].join('');
    const hashText = `token: ${hashed}`;
    expect(guardSecretSpan(hashText, spanOf(hashText, 'cobalt-harbor'), 'access token'))
      .toEqual(spanOf(hashText, hashed));
    const dotted = ['Cobalt', 'Harbor', 'Winter'].join('.');
    const dotText = `token: ${dotted}`;
    expect(guardSecretSpan(dotText, spanOf(dotText, 'Winter'), 'access token'))
      .toEqual(spanOf(dotText, dotted));
  });
});
