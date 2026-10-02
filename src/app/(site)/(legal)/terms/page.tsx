import type { Metadata } from 'next';

import { APP_NAME } from '@/lib/config';

export const metadata: Metadata = { title: 'Terms of service' };

export default function TermsPage() {
  return (
    <>
      <h1>Terms of service</h1>
      <section>
        <h2>The service</h2>
        <p>
          [{APP_NAME} lets restaurants take table orders by QR code, run their kitchen and waiter
          screens, and print bills. Who may use it.]
        </p>
      </section>
      <section>
        <h2>Accounts</h2>
        <p>[The owner is responsible for the logins they create for their staff.]</p>
      </section>
      <section>
        <h2>Plans, trial and payment</h2>
        <p>
          [The free trial, plan prices and limits, the one-time setup fee, autopay through Razorpay,
          taxes, refunds.]
        </p>
      </section>
      <section>
        <h2>Unpaid and suspended accounts</h2>
        <p>
          [After the grace period a restaurant becomes read-only: its data stays, open tables can
          still be billed, and new orders stop until it pays. Suspension for misuse.]
        </p>
      </section>
      <section>
        <h2>The restaurant’s responsibilities</h2>
        <p>
          [Menu, prices, taxes, food safety and the bills given to diners are the restaurant’s.]
        </p>
      </section>
      <section>
        <h2>Availability and liability</h2>
        <p>[Uptime, support, and the limit of liability.]</p>
      </section>
      <section>
        <h2>Ending the service</h2>
        <p>[Cancelling, exporting data, and what happens to it afterwards.]</p>
      </section>
      <section>
        <h2>Governing law</h2>
        <p>[Indian law; the courts of the chosen city.]</p>
      </section>
    </>
  );
}
