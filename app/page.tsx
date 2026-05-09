export default function LandingPage() {
  return (
    <main className="min-h-[calc(100vh-3.25rem)] flex items-center justify-center px-6">
      <div className="max-w-2xl w-full">
        <h1 className="text-5xl font-semibold tracking-tight leading-[1.05] mb-6">
          Hire an agent. Don&apos;t configure one.
        </h1>
        <p className="text-lg text-[var(--color-muted)] mb-8 leading-relaxed">
          Day0 joins on day zero with no role, no skills, no scope. You give it a name; everything
          else is learned by talking to its boss.
        </p>
        <p className="mt-12 text-xs text-[var(--color-muted)]">
          Built on OpenAI GPT-5.5, ElevenLabs Conversational AI, Convex, Mastra, Exa, Daytona,
          Vercel, Cloudflare, Clerk.
        </p>
        <p className="mt-4 text-xs text-[var(--color-muted)]">
          Phase 1 scaffold — auth, backend, and demo flow land in subsequent commits.
        </p>
      </div>
    </main>
  );
}
