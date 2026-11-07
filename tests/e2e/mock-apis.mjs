// Stand-ins for the outside APIs the app calls, so E2E needs no real keys:
//
// - The menu reader, an OpenAI-compatible /v1/chat/completions API
//   (docs/DECISIONS.md P7-12). A detailed photo returns the fixture menu; a
//   nearly blank one (a tiny JPEG) returns no dishes, like a real reader given
//   a blurry or empty photo. Hindi name requests (HN-5) are answered from a
//   small word list; a name with any other word comes back unchanged, which
//   the app rejects, so other tests' dishes keep no automatic name.
// - Razorpay under /razorpay/v1 (P8-1): plans, subscriptions and payment
//   links, kept in memory. Fetching a subscription that was just created
//   answers "authenticated", as if Checkout had been completed.
// - Resend under /resend (P8-12): POST /emails keeps each email (once per
//   Idempotency-Key, as Resend does); GET /inbox?to=<address> lists them.
// - Cloudflare Turnstile's siteverify under /turnstile (W-6): Cloudflare's
//   test secret accepts only its dummy token, as the real one does.
// - Sentry's issues under /sentry/api/0 (SA-89): two fixed issues.
// - The other deployments' /api/health under /deploy (SA-92): production is
//   up on a fixed commit, staging answers that its database is down.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_APIS_PORT ?? 3190);
const API_KEY = 'e2e-menu-reader-key';
const RAZORPAY_AUTH = `Basic ${Buffer.from('rzp_test_e2e:e2e-razorpay-secret').toString('base64')}`;
const RESEND_AUTH = 'Bearer re_e2e_resend_key';
/** Cloudflare's always-pass test secret and the token its test widgets give. */
const TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
const TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const SENTRY_AUTH = 'Bearer e2e-sentry-token';
const SENTRY_ISSUES = [
  {
    id: '1001',
    shortId: 'MENUMESH-1',
    title: 'TypeError: e2e issue one',
    culprit: 'app/admin/page',
    count: '42',
    userCount: 3,
    lastSeen: '2026-10-16T05:00:00Z',
    permalink: 'https://sentry.example/issues/1001/',
  },
  {
    id: '1002',
    shortId: 'MENUMESH-2',
    title: 'Error: e2e issue two',
    culprit: null,
    count: '1',
    userCount: 1,
    lastSeen: '2026-10-16T04:00:00Z',
    permalink: 'https://sentry.example/issues/1002/',
  },
];
const PRODUCTION_SHA = 'abc1234def5678abc1234def5678abc1234def56';
/** Words the Hindi name stand-in knows (tests/e2e/admin-menu.spec.ts). */
const HINDI_WORDS = { masala: 'मसाला', chai: 'चाय', kadak: 'कड़क' };

function hindiNames(body) {
  const sent = JSON.parse(body.messages.find((message) => message.role === 'user').content);
  return sent.map(({ n, name }) => {
    const words = name.toLowerCase().split(/\s+/);
    const known = words.every((word) => Object.hasOwn(HINDI_WORDS, word));
    return { n, hindi: known ? words.map((word) => HINDI_WORDS[word]).join(' ') : name };
  });
}

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
const paymentLinks = [];
const plans = new Map(); // plan id → plan
const emails = new Map(); // Idempotency-Key → email

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

  if (request.method === 'GET' && path === '/payment_links') {
    send(response, 200, { payment_links: paymentLinks });
    return;
  }
  const planMatch = request.method === 'GET' && path.match(/^\/plans\/(plan_\w+)$/);
  if (planMatch) {
    const plan = plans.get(planMatch[1]);
    if (!plan) return notFound();
    send(response, 200, plan);
    return;
  }
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
      const plan = { id: newId('plan'), entity: 'plan', period: body.period, item: body.item };
      plans.set(plan.id, plan);
      send(response, 200, plan);
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
      const link = {
        id,
        amount: body.amount,
        description: body.description,
        customer: body.customer ?? {},
        notes: body.notes ?? {},
        status: 'created',
        short_url: `https://rzp.io/l/${id}`,
      };
      paymentLinks.push(link);
      send(response, 200, link);
      return;
    }
    send(response, 404, { error: { code: 'BAD_REQUEST_ERROR', description: 'Not found' } });
  });
}

function resend(request, response, path) {
  if (request.method === 'GET' && path === '/inbox') {
    const to = new URL(request.url ?? '/', 'http://mock').searchParams.get('to');
    send(response, 200, {
      emails: [...emails.values()].filter((email) => !to || email.to.includes(to)),
    });
    return;
  }
  if (request.headers.authorization !== RESEND_AUTH) {
    send(response, 401, { name: 'missing_api_key', message: 'API key is invalid' });
    return;
  }
  if (request.method !== 'POST' || path !== '/emails') {
    send(response, 404, { name: 'not_found', message: 'Not found' });
    return;
  }
  readJson(request, (body) => {
    if (!body?.from || !Array.isArray(body.to) || !body.subject) {
      send(response, 422, {
        name: 'validation_error',
        message: 'from, to and subject are required',
      });
      return;
    }
    const key = request.headers['idempotency-key'] ?? randomUUID();
    if (!emails.has(key)) emails.set(key, { id: randomUUID(), idempotencyKey: key, ...body });
    send(response, 200, { id: emails.get(key).id });
  });
}

function turnstile(request, response, path) {
  if (request.method !== 'POST' || path !== '/siteverify') {
    send(response, 404, { success: false, 'error-codes': ['bad-request'] });
    return;
  }
  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    const form = new URLSearchParams(raw);
    if (form.get('secret') !== TURNSTILE_SECRET) {
      send(response, 200, { success: false, 'error-codes': ['invalid-input-secret'] });
      return;
    }
    const ok = form.get('response') === TURNSTILE_TOKEN;
    send(
      response,
      200,
      ok
        ? { success: true, action: 'lead' }
        : { success: false, 'error-codes': ['invalid-input-response'] },
    );
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
  if (path.startsWith('/resend/')) {
    resend(request, response, path.slice('/resend'.length));
    return;
  }
  if (path.startsWith('/turnstile/')) {
    turnstile(request, response, path.slice('/turnstile'.length));
    return;
  }
  if (path.startsWith('/sentry/api/0/organizations/')) {
    if (request.headers.authorization !== SENTRY_AUTH)
      send(response, 401, { detail: 'Invalid token' });
    else send(response, 200, path.endsWith('/issues/') ? SENTRY_ISSUES : []);
    return;
  }
  if (path === '/deploy/production/api/health') {
    send(response, 200, { status: 'ok', db: 'ok', version: PRODUCTION_SHA, time: new Date() });
    return;
  }
  if (path === '/deploy/staging/api/health') {
    send(response, 503, { status: 'error', db: 'error', time: new Date() });
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
    if (body.response_format?.json_schema?.name === 'hindi_names') {
      send(response, 200, {
        id: 'chatcmpl-e2e',
        object: 'chat.completion',
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify({ names: hindiNames(body) }) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 },
      });
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
