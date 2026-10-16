import { getCore } from '@/lib/runtime';
import { ClientReviewClient } from './review-client';

export const dynamic = 'force-dynamic';

export default async function ClientReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const portal = await getCore().taskOperations.clientReviewPortal(token);
    return <ClientReviewClient token={token} portal={portal} />;
  } catch {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center px-5 py-12">
        <section className="w-full rounded-2xl border border-line bg-white p-7 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-500">FlowPilot client review</p>
          <h1 className="mt-3 text-xl font-semibold text-ink-900">This review link is no longer available</h1>
          <p className="mt-2 text-sm leading-6 text-ink-500">It may have expired or already received a response. Please ask your project contact for an updated link.</p>
        </section>
      </main>
    );
  }
}
