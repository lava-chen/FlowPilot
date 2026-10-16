'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, AlertCircle, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/primitives';
import { apiFetch } from '@/lib/api-client';

const DEMO_ACCOUNTS = [
  { email: 'dana@northlinecreative.com', name: 'Dana Reyes', role: 'Owner' },
  { email: 'marcus@northlinecreative.com', name: 'Marcus Webb', role: 'Admin · account lead' },
  { email: 'priya@northlinecreative.com', name: 'Priya Natarajan', role: 'Manager · producer' },
  { email: 'theo@northlinecreative.com', name: 'Theo Brandt', role: 'Member · editor' },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(DEMO_ACCOUNTS[1]!.email);
  const [password, setPassword] = useState('demo1234');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await apiFetch('/api/auth/login', { method: 'POST', json: { email, password } });
      router.push('/overview');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-ink-900 px-4 py-10">
      <div className="w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-800 bg-ink-900 shadow-2xl md:grid md:grid-cols-[1.1fr_1fr]">
        <section className="hidden flex-col justify-between border-r border-slate-800 p-8 md:flex">
          <div>
            <div className="flex items-center gap-2 text-white">
              <Sparkles className="h-5 w-5 text-indigo-400" />
              <span className="text-sm font-semibold tracking-tight">FlowPilot</span>
            </div>
            <h1 className="mt-10 text-2xl font-semibold leading-snug text-white">
              Agents prepare the work.
              <br />
              <span className="text-indigo-400">People decide what ships.</span>
            </h1>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-slate-400">
              Connect the SaaS a creative agency already runs on, turn inbound client requests into
              reviewable work, and keep the approval rights with your project managers.
            </p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-xs font-medium text-slate-300">Demo tenant</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Northline Creative — a fictional 8-person US creative agency. All companies, people and
              projects in this instance are simulated.
            </p>
          </div>
        </section>

        <section className="bg-white p-8">
          <div className="md:hidden">
            <div className="flex items-center gap-2 text-ink-900">
              <Sparkles className="h-5 w-5 text-accent" />
              <span className="text-sm font-semibold">FlowPilot</span>
            </div>
          </div>

          <h2 className="mt-4 text-lg font-semibold text-ink-900">Sign in</h2>
          <p className="mt-1 text-xs text-ink-500">Use one of the seeded demo accounts.</p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Work email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {error ? (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            ) : null}

            <Button type="submit" className="w-full" loading={loading} size="lg">
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          </form>

          <div className="mt-6 border-t border-line pt-4">
            <p className="text-[11px] font-medium tracking-wide text-ink-500 uppercase">Demo accounts · password demo1234</p>
            <ul className="mt-2 space-y-1">
              {DEMO_ACCOUNTS.map((account) => (
                <li key={account.email}>
                  <button
                    type="button"
                    onClick={() => setEmail(account.email)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-ink-700 hover:bg-slate-50"
                  >
                    <span>{account.name}</span>
                    <span className="text-ink-500">{account.role}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </main>
  );
}
