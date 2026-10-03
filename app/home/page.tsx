import { redirect } from 'next/navigation';

/**
 * The `/home` address. Day0's home is `/`, where a signed-in manager's employees are; `/home`
 * needs a sign-in like every owned page (`proxy.ts`), so a signed-out visitor reaches Day0's
 * sign-in and, once signed in, comes back here and on to the home rather than to a missing page.
 */
export default function HomeAddressPage(): never {
  redirect('/');
}
