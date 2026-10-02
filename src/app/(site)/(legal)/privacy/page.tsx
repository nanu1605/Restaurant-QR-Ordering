import type { Metadata } from 'next';

import { APP_NAME } from '@/lib/config';

export const metadata: Metadata = { title: 'Privacy policy' };

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy policy</h1>
      <section>
        <h2>Who we are</h2>
        <p>[The legal name, address and contact email of the business that runs {APP_NAME}.]</p>
      </section>
      <section>
        <h2>Diners</h2>
        <p>
          Diners don’t sign up and we don’t ask for names or phone numbers. A phone gets an
          anonymous device cookie (kept for a year) so its own dishes can be followed and cancelled
          at the table, and a cookie for the chosen language. We keep the orders placed, with any
          notes, for the restaurant’s bills and reports.
        </p>
      </section>
      <section>
        <h2>Restaurants and their staff</h2>
        <p>
          [Owner name, email and phone; staff names and usernames; waiter names and optional phone
          numbers; a log of actions in the restaurant’s account. Why each is needed.]
        </p>
      </section>
      <section>
        <h2>Service providers</h2>
        <p>
          Supabase (database, Mumbai, India), Vercel (hosting), Sentry (error reports), PostHog
          (usage of the staff and admin screens only, never diners’ phones), Razorpay (subscription
          payments by restaurants) and Resend (billing emails to owners). [Confirm the list and
          their regions.]
        </p>
      </section>
      <section>
        <h2>How long we keep data</h2>
        <p>[Retention for orders, bills, logs and closed accounts.]</p>
      </section>
      <section>
        <h2>Your rights</h2>
        <p>
          [Access, correction and erasure under India’s Digital Personal Data Protection Act, 2023,
          and the name and contact of the Grievance Officer.]
        </p>
      </section>
      <section>
        <h2>Changes to this policy</h2>
        <p>[How changes are announced; the date of the current version.]</p>
      </section>
    </>
  );
}
