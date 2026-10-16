import { redirect } from 'next/navigation';
import { getActor } from '@/lib/auth';

export default async function Home() {
  const actor = await getActor();
  redirect(actor ? '/overview' : '/login');
}
