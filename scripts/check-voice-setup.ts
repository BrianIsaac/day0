/// <reference types="node" />
/**
 * Reports whether voice is configured, and separately whether post-call
 * finalisation is.
 *
 *   pnpm check:voice
 *
 * They are two setups, not one, and the first is the visible half: with an API
 * key and an agent id the boss can hold the whole Day-1 1:1 over voice and get a
 * charter out of it, because the browser posts the transcript when the call ends
 * normally. The post-call webhook is what covers the call that does not end
 * normally - a closed tab, a dropped connection - and it runs on a third secret
 * the other two say nothing about. Without it the route refuses every delivery
 * with a 503 by design, so a setup can look complete right up to the first call
 * somebody walks away from.
 *
 * Two of the three facts this needs are local. The third is not: whether the
 * agent declares the dynamic variables the browser sends can only be read off
 * the ElevenLabs dashboard, so this prints them to check by eye rather than
 * guessing. Nothing here calls ElevenLabs.
 */
import { existsSync, readFileSync } from 'node:fs';

const ENV_FILE = process.argv[2] ?? '.env.local';

const WEBHOOK_PATH = '/api/voice/elevenlabs/webhook';

/** Sent by `startSession({ dynamicVariables })` and read back off the webhook payload. */
const DYNAMIC_VARIABLES = ['internal_agent_id', 'internal_session_token', 'boss_label'] as const;

type Status = 'ok' | 'warn' | 'gap';

interface Section {
  title: string;
  status: Status;
  lines: string[];
}

function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return values;
}

function main(): void {
  if (!existsSync(ENV_FILE)) {
    console.error(`error: ${ENV_FILE} not found. Copy .env.example to ${ENV_FILE} first.`);
    process.exit(1);
  }

  const values = { ...readEnvFile(ENV_FILE) };
  for (const key of ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_WEBHOOK_SECRET']) {
    const fromEnvironment = process.env[key];
    if (fromEnvironment) values[key] = fromEnvironment;
  }

  const voiceGaps = ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID'].filter((key) => !values[key]);
  const hasSecret = !!values.ELEVENLABS_WEBHOOK_SECRET;
  const voiceConfigured = voiceGaps.length === 0;

  const sections: Section[] = [voiceSection(voiceGaps), finalisationSection(voiceConfigured, hasSecret)];

  console.log(`Voice setup, read from ${ENV_FILE}\n`);
  for (const section of sections) {
    console.log(`${marker(section.status)} ${section.title}`);
    for (const line of section.lines) console.log(`    ${line}`);
    console.log('');
  }

  if (voiceConfigured) {
    console.log('  Declare these dynamic variables on the ElevenLabs agent - the browser sends');
    console.log('  them on every call and the webhook reads two of them back:');
    for (const name of DYNAMIC_VARIABLES) console.log(`    ${name}`);
    console.log('  Only the dashboard knows whether they are declared, so check that by eye.\n');
  }

  // The one state worth failing on is the one that looks finished: voice
  // connects, the demo works, and every post-call delivery is refused.
  if (voiceConfigured && !hasSecret) process.exit(1);
}

function voiceSection(gaps: string[]): Section {
  if (gaps.length === 0) {
    return {
      title: 'Voice connects',
      status: 'ok',
      lines: ['ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are set.'],
    };
  }
  return {
    title: 'Voice does not connect',
    status: 'warn',
    lines: [
      `Missing ${gaps.join(' and ')}.`,
      'The mode picker greys voice out and chat runs the identical Day-1 1:1,',
      'so this is a complete setup if you meant to skip voice.',
    ],
  };
}

function finalisationSection(voiceConfigured: boolean, hasSecret: boolean): Section {
  if (hasSecret) {
    return {
      title: 'Post-call finalisation is configured',
      status: 'ok',
      lines: [
        'ELEVENLABS_WEBHOOK_SECRET is set, so a signed delivery is accepted and a',
        `call whose tab died still lands a charter. The agent's post-call webhook`,
        `must point at this deployment's ${WEBHOOK_PATH}.`,
      ],
    };
  }
  if (!voiceConfigured) {
    return {
      title: 'Post-call finalisation is not configured',
      status: 'warn',
      lines: [
        'ELEVENLABS_WEBHOOK_SECRET is unset. Nothing to fix while voice is off.',
      ],
    };
  }
  return {
    title: 'Post-call finalisation is NOT configured',
    status: 'gap',
    lines: [
      'ELEVENLABS_WEBHOOK_SECRET is unset, so the route cannot tell a real',
      'ElevenLabs delivery from a forged one and answers 503 to all of them.',
      'Voice still works and the browser still posts the transcript when the',
      'call ends normally; a call whose tab dies mid-way is lost silently.',
      'Fix: ElevenLabs dashboard -> Developers -> Webhooks -> Create webhook',
      `pointed at https://<your-host>${WEBHOOK_PATH}, copy the shared`,
      `secret it shows once into ${ENV_FILE}, restart \`pnpm dev\`.`,
    ],
  };
}

function marker(status: Status): string {
  return status === 'ok' ? 'ok  ' : status === 'warn' ? 'note' : 'GAP ';
}

main();
