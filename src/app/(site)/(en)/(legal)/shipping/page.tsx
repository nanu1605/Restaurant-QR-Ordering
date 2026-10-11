import type { Metadata } from 'next';

import { APP_NAME } from '@/lib/config';

export const metadata: Metadata = {
  title: 'Shipping and delivery',
  description:
    'MenuMesh is used in the browser: nothing is shipped, and an account is ready as soon as it is created.',
};

export default function ShippingPage() {
  return (
    <>
      <h1>Shipping and delivery</h1>
      <section>
        <h2>An online service</h2>
        <p>
          {APP_NAME} is software used in the browser. Nothing is shipped: the restaurant’s account
          is ready as soon as it is created, and a plan takes effect as soon as it is paid for.
        </p>
      </section>
      <section>
        <h2>QR code cards</h2>
        <p>
          [Whether printed QR code cards or standees are offered, and how and when they are
          delivered.]
        </p>
      </section>
    </>
  );
}
