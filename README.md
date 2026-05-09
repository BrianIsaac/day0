# Day0

Autonomous teammate that joins on day zero with no role, no skills, no scope — and figures it all out by talking to its boss.

> Built for the AI Engineer Hackathon, Singapore — 9 May 2026.

## The 90-second pitch

Every "digital employee" vendor in 2026 ships the same template: pre-load the agent with a role, knowledge, and tools before it runs. Designing the digital employee has become the bottleneck — 4 to 12 weeks of professional services per deployment.

Day0 inverts the shape. **One name in. Everything else is learned state.** Charter, skills, work scope, permissions — none of them exist at deploy time. The agent acquires them by talking to its boss the way a competent new hire would.

The headline demo: Day0 joins, gets its charter over a 5-minute voice call, sees a doc-reading task it can do, then sees a spreadsheet-update task it cannot — proposes a new skill, has it authored in a Daytona sandbox after the boss approves, and uses the new skill to finish the task. Every step visible on screen.

## Status

Actively building. Public commits land in phases:

- [x] Repo bootstrap
- [x] Next.js 16 + Tailwind v4 shell
- [ ] Clerk auth
- [ ] Convex schema + provider
- [ ] Agent — charter, day-1 1:1, good-habits memory
- [ ] Voice — ElevenLabs primary, Gemini Live fallback, chat
- [ ] Work loop — 7-criterion evaluator, plan drafter, executor
- [ ] Skills loop — propose, Daytona author, register
- [ ] Mock environment, seed, and demo polish

## Stack

Next.js 16, React 19, Tailwind v4, TypeScript 6, Convex, Clerk, OpenAI GPT-5.5, ElevenLabs Conversational AI, Google Gemini Live, Mastra, Exa, Daytona, Vercel, Cloudflare.

## Local dev

```bash
pnpm install
pnpm dev   # http://localhost:3000
```

The full setup contract — Clerk, Convex, OpenAI, ElevenLabs, Exa, Daytona keys, plus the Cloudflare tunnel for ElevenLabs webhooks — lands alongside the phases that need them.
