import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Refunds and cancellation',
  description: 'How the free trial, cancelling a plan and refunds work.',
};

export default function RefundPage() {
  return (
    <>
      <h1>Refunds and cancellation</h1>
      <section>
        <h2>Free trial</h2>
        <p>[The trial is free; nothing is charged until it ends, and it can be ended any time.]</p>
      </section>
      <section>
        <h2>Cancelling a plan</h2>
        <p>
          [How to cancel autopay, and that access continues until the end of the period already paid
          for.]
        </p>
      </section>
      <section>
        <h2>Refunds</h2>
        <p>[When a payment is refunded, how to ask, and how long it takes to reach the account.]</p>
      </section>
      <section>
        <h2>Contact</h2>
        <p>[Support email and phone for billing questions.]</p>
      </section>
    </>
  );
}
