'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, Inbox, Columns3, Activity, LogOut, Settings2, Sparkles, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api-client';

const NAV = [
  { href: '/overview', label: 'Overview', icon: LayoutDashboard },
  { href: '/inbox', label: 'AI Inbox', icon: Inbox },
  { href: '/tasks', label: 'Tasks', icon: Columns3 },
  { href: '/activity', label: 'Activity', icon: Activity },
];

const SETTINGS = [
  { href: '/settings/integrations', label: 'Integrations' },
  { href: '/settings/ai', label: 'AI settings' },
];

export function Sidebar({
  organizationName,
  userName,
  userRole,
}: {
  organizationName: string;
  userName: string;
  userRole: string;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const signOut = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  return (
    <aside className="flex shrink-0 flex-col justify-between bg-ink-900 px-3 py-4 text-slate-300 md:sticky md:top-0 md:h-dvh md:w-60 md:overflow-y-auto">
      <div>
        <Link href="/overview" className="mb-6 flex items-center gap-2 px-2 text-white">
          <Sparkles className="h-4 w-4 text-indigo-400" />
          <span className="text-sm font-semibold tracking-tight">FlowPilot</span>
        </Link>

        <nav className="space-y-0.5">
          {NAV.filter((item) => !('adminOnly' in item) || !item.adminOnly || userRole === 'owner' || userRole === 'admin').map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors',
                  active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {item.label}
              </Link>
            );
          })}
          {userRole === 'owner' || userRole === 'admin' ? (
            <details className="group pt-2" open={pathname.startsWith('/settings')}>
              <summary className={cn(
                'flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors [&::-webkit-details-marker]:hidden',
                pathname.startsWith('/settings') ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200',
              )}>
                <Settings2 className="h-4 w-4" aria-hidden />
                <span className="flex-1">Settings</span>
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="ml-7 mt-0.5 space-y-0.5 border-l border-slate-700 pl-2">
                {SETTINGS.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        'block rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                        active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200',
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </details>
          ) : null}
        </nav>
      </div>

      <div className="space-y-3">
        <div className="rounded-lg bg-slate-900 px-2.5 py-2">
          <p className="truncate text-xs font-medium text-slate-200">{organizationName}</p>
          <p className="truncate text-[11px] text-slate-500">{userName} · {userRole}</p>
        </div>
        <button
          type="button"
          onClick={signOut}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-slate-400 hover:bg-slate-900 hover:text-slate-200"
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </button>
      </div>
    </aside>
  );
}

/** Banner that keeps "this is a simulated tenant" visible on every page. */
export function DemoBanner() {
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-[11px] text-amber-800">
      Demo data — Northline Creative is fictional. The AI provider is configured per organization.
    </div>
  );
}
