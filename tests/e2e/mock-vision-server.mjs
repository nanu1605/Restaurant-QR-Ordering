// A stand-in for the menu reader (an OpenAI-compatible /chat/completions API)
// so E2E can import from photos without a real key (docs/DECISIONS.md P7-12).
// A detailed photo returns the fixture menu; a nearly blank one (a tiny JPEG)
// returns no dishes, like a real reader given a blurry or empty photo.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_VISION_PORT ?? 3190);
const API_KEY = 'e2e-menu-reader-key';
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

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    send(response, 200, { ok: true });
    return;
  }
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
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
  console.log(`Mock menu reader on http://127.0.0.1:${PORT}`);
});
