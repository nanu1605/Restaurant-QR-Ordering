import type { Metadata } from 'next';

import { APP_NAME } from '@/lib/config';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description: 'What MenuMesh keeps about restaurants, their staff and their guests, and why.',
};

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
        <h2>People who book a demo</h2>
        <p>
          The “Book a demo” form asks for your name, your restaurant’s name and city, your mobile
          number, and optionally your email, the plan you’re interested in and a message. We use
          them only to contact you about a demo. To limit abuse we keep a keyed hash of your network
          address with the request, not the address itself. If you came from a link with campaign
          tags, or from another website, we keep those tags and that site’s name with the request,
          so we know which of our announcements work. [Retention for demo requests.]
        </p>
      </section>
      <section>
        <h2>People who sign up</h2>
        <p>
          The sign-up form asks for your restaurant’s name, city and menu style, your name, email
          and mobile number. We email you a code to confirm the address. Until you enter it, we keep
          these details for at most 7 days, with a keyed hash of your network address to limit
          abuse; once you do, they become your restaurant’s account. As with demo requests, we keep
          the campaign tags of the link you came from, and the website that sent you, with your
          restaurant.
        </p>
      </section>
      <section>
        <h2>Cookies and analytics</h2>
        <p>
          Diners’ phones get the device cookie and the language cookie described above. Anyone who
          picks a light or dark look gets a cookie that remembers it for a year. While you sign up,
          a cookie remembers for an hour which sign-up you’re confirming. Staff and admins get the
          cookies that keep them logged in, and PostHog’s cookie for how those screens are used.
        </p>
        <p>
          On this website we count visits with PostHog without cookies or anything else stored on
          your device: a random number that lasts until the page is reloaded links the pages of one
          visit, and the links to sign up or book a demo that you click. We never send what you
          type. Our servers also tell PostHog when a demo request is sent or a sign-up starts or
          finishes, with the plan, the campaign tags and that random number, never your details.
          PostHog doesn’t keep network addresses for us. If your browser sends Do Not Track or
          Global Privacy Control, nothing about your visit goes to PostHog.
        </p>
      </section>
      <section>
        <h2>Service providers</h2>
        <p>
          Supabase (database, Mumbai, India), Vercel (hosting), Sentry (error reports), PostHog (EU;
          how this website and the staff and admin screens are used, never diners’ phones), Razorpay
          (subscription payments by restaurants), Resend (sign-up codes, welcome and billing emails
          to owners, and demo requests to our team) and Cloudflare Turnstile (a bot check on the
          website’s forms, which sees your network address and browser signals). [Confirm the list
          and their regions.]
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
