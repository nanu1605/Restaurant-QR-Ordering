// Stand-ins for the outside APIs the app calls, so E2E needs no real keys:
//
// - The menu reader, an OpenAI-compatible /v1/chat/completions API
//   (docs/DECISIONS.md P7-12). A detailed photo returns the fixture menu; a
//   nearly blank one (a tiny JPEG) returns no dishes, like a real reader given
//   a blurry or empty photo.
// - Razorpay under /razorpay/v1 (P8-1): plans, subscriptions and payment
//   links, kept in memory. Fetching a subscription that was just created
//   answers "authenticated", as if Checkout had been completed.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_APIS_PORT ?? 3190);
const API_KEY = 'e2e-menu-reader-key';
const RAZORPAY_AUTH = `Basic ${Buffer.from('rzp_test_e2e:e2e-razorpay-secret').toString('base64')}`;
/** Base64 characters below which a photo counts as blank. */
const BLANK_BELOW = 60_000;

export const FIXTURE_MENU = {
  categories: [
    {
      name: 'Starters',
      confidence: 'high',
      items: [
        {
          name: 'Paneer Tikka',
          description: 'Cottage cheese, peppers, onion',
          food_type: 'veg',
          price: 280,
          variants: [],
          confidence: 'high',
          notes: null,
        },
        {
          name: 'Chicken Tikka',
          description: null,
          food_type: 'non_veg',
          price: null,
          variants: [
            { name: 'Half', price: 220 },
            { name: 'Full', price: 400 },
          ],
          confidence: 'high',
          notes: null,
        },
        {
          name: 'Hara Bhara Kebab',
          description: null,
          food_type: 'unknown',
          price: null,
          variants: [],
          confidence: 'low',
          notes: 'price unclear',
        },
      ],
    },
    {
      name: 'Breads',
      confidence: 'high',
      items: [
        {
          name: 'Butter Naan',
          description: null,
          food_type: 'veg',
          price: 60,
          variants: [],
          confidence: 'high',
          notes: null,
        },
      ],
    },
  ],
  page_notes: null,
};

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readJson(request, callback) {
  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    try {
      callback(raw ? JSON.parse(raw) : {});
    } catch {
      callback(null);
    }
  });
}

const newId = (prefix) => `${prefix}_E2E${randomUUID().replaceAll('-', '').slice(0, 14)}`;
const subscriptions = new Map();

function razorpay(request, response, path) {
  if (request.headers.authorization !== RAZORPAY_AUTH) {
    send(response, 401, {
      error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' },
    });
    return;
  }
  const notFound = () =>
    send(response, 400, {
      error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
    });

  if (request.method === 'GET') {
    const match = path.match(/^\/subscriptions\/(sub_\w+)$/);
    const subscription = match && subscriptions.get(match[1]);
    if (!subscription) return notFound();
    if (subscription.status === 'created') subscription.status = 'authenticated';
    send(response, 200, subscription);
    return;
  }

  readJson(request, (body) => {
    if (body === null) {
      send(response, 400, {
        error: { code: 'BAD_REQUEST_ERROR', description: 'Body is not JSON' },
      });
      return;
    }
    if (path === '/plans') {
      send(response, 200, {
        id: newId('plan'),
        entity: 'plan',
        period: body.period,
        item: body.item,
      });
      return;
    }
    if (path === '/subscriptions') {
      const subscription = {
        id: newId('sub'),
        entity: 'subscription',
        plan_id: body.plan_id,
        status: 'created',
        total_count: body.total_count,
        start_at: body.start_at ?? null,
        current_start: null,
        current_end: null,
        notes: body.notes ?? {},
        short_url: 'https://rzp.io/i/e2e',
      };
      subscriptions.set(subscription.id, subscription);
      send(response, 200, subscription);
      return;
    }
    const cancel = path.match(/^\/subscriptions\/(sub_\w+)\/cancel$/);
    if (cancel) {
      const subscription = subscriptions.get(cancel[1]);
      if (!subscription) return notFound();
      // Like Razorpay: a subscription can be cancelled once.
      if (subscription.status === 'cancelled' || subscription.has_scheduled_changes) {
        send(response, 400, {
          error: { code: 'BAD_REQUEST_ERROR', description: 'Subscription is already cancelled' },
        });
        return;
      }
      if (body.cancel_at_cycle_end) subscription.has_scheduled_changes = true;
      else subscription.status = 'cancelled';
      send(response, 200, subscription);
      return;
    }
    if (path === '/payment_links') {
      const id = newId('plink');
      send(response, 200, {
        id,
        amount: body.amount,
        notes: body.notes ?? {},
        status: 'created',
        short_url: `https://rzp.io/l/${id}`,
      });
      return;
    }
    send(response, 404, { error: { code: 'BAD_REQUEST_ERROR', description: 'Not found' } });
  });
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://mock').pathname;
  if (request.method === 'GET' && path === '/health') {
    send(response, 200, { ok: true });
    return;
  }
  if (path.startsWith('/razorpay/v1/')) {
    razorpay(request, response, path.slice('/razorpay/v1'.length));
    return;
  }
  if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
    send(response, 404, { error: { message: 'Not found' } });
    return;
  }
  if (request.headers.authorization !== `Bearer ${API_KEY}`) {
    send(response, 401, { error: { message: 'Invalid API key' } });
    return;
  }

  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      send(response, 400, { error: { message: 'Body is not JSON' } });
      return;
    }
    const user = body.messages?.find((message) => message.role === 'user');
    const image = Array.isArray(user?.content)
      ? user.content.find((part) => part.type === 'image_url')?.image_url?.url
      : undefined;
    if (!image?.startsWith('data:image/jpeg;base64,')) {
      send(response, 400, { error: { message: 'Expected a JPEG image' } });
      return;
    }
    const blank = image.length < BLANK_BELOW;
    const menu = blank
      ? { categories: [], page_notes: 'The photo is blank; no menu text is visible.' }
      : FIXTURE_MENU;
    send(response, 200, {
      id: 'chatcmpl-e2e',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(menu) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1500, completion_tokens: blank ? 30 : 600, total_tokens: 2100 },
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock APIs on http://127.0.0.1:${PORT}`);
});
