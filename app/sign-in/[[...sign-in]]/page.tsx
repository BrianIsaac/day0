import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-[var(--color-bg)]">
      <div className="max-w-md w-full">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-accent)] mb-3 text-center">
          Day0
        </p>
        <h1 className="text-3xl font-semibold tracking-tight mb-6 text-center">
          Sign in to deploy your agent
        </h1>
        <div className="flex justify-center">
          <SignIn
            appearance={{
              variables: {
                colorPrimary: '#22d3ee',
                colorBackground: '#18181b',
                colorText: '#f4f4f5',
                colorInputBackground: '#0a0a0b',
                colorInputText: '#f4f4f5',
              },
            }}
          />
        </div>
      </div>
    </main>
  );
}
