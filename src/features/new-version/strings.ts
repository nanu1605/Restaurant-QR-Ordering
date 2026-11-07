import type { Lang } from '@/features/ordering/strings';

/**
 * The words for a page from an older build, in English and Hindi (docs/DECISIONS.md VPS-12).
 * They follow <html lang>, so the worker panel's login language, the guest's choice and /hi
 * apply. They never name the product: guests only know the restaurant. Both languages reach
 * every page's script (about 1 KiB), unlike the website's words (W-15). Hindi has every English
 * key (the compiler checks) and writes nuktas as separate marks.
 */

const en = {
  refreshing: 'A new version is ready. Refreshing…',
  ready: {
    title: 'A new version is ready',
    description: 'Refresh the page to keep working.',
    copyFirst: 'Copy anything you’ve typed first.',
  },
  stuck: {
    title: 'The new version didn’t load',
    description: 'Refresh the page. If this keeps happening, close the page and open it again.',
  },
  updated: {
    title: 'Updated to the new version',
    description: 'If what you just did didn’t go through, please do it again.',
  },
  /** A script that didn't load: usually the connection, so no new version is claimed. */
  chunk: {
    refreshing: 'Part of this page didn’t load. Refreshing…',
    title: 'Part of this page didn’t load',
    description: 'Check the connection, then refresh the page.',
  },
  cartSaved: 'Your cart is saved.',
  refresh: 'Refresh',
  error: {
    title: 'Something went wrong',
    description: 'Try again, or refresh the page.',
    retry: 'Try again',
    code: (digest: string) => `Error code ${digest}`,
  },
};

export type NewVersionStrings = typeof en;

const hi: NewVersionStrings = {
  refreshing: 'नया वर्ज़न तैयार है। पेज रीफ़्रेश हो रहा है…',
  ready: {
    title: 'नया वर्ज़न तैयार है',
    description: 'काम जारी रखने के लिए पेज रीफ़्रेश करें।',
    copyFirst: 'पहले अपना लिखा हुआ कॉपी कर लें।',
  },
  stuck: {
    title: 'नया वर्ज़न नहीं खुल पाया',
    description: 'पेज रीफ़्रेश करें। ऐसा बार-बार हो, तो पेज बंद करके फिर से खोलें।',
  },
  updated: {
    title: 'नया वर्ज़न आ गया है',
    description: 'अगर आपका पिछला काम पूरा नहीं हुआ, तो उसे फिर से करें।',
  },
  chunk: {
    refreshing: 'पेज पूरा नहीं खुल पाया। पेज रीफ़्रेश हो रहा है…',
    title: 'पेज पूरा नहीं खुल पाया',
    description: 'कनेक्शन जाँचें, फिर पेज रीफ़्रेश करें।',
  },
  cartSaved: 'आपका कार्ट सुरक्षित है।',
  refresh: 'रीफ़्रेश करें',
  error: {
    title: 'कुछ गड़बड़ हो गई',
    description: 'फिर से कोशिश करें, या पेज रीफ़्रेश करें।',
    retry: 'फिर से कोशिश करें',
    code: (digest) => `एरर कोड ${digest}`,
  },
};

export const NEW_VERSION_STRINGS: Record<Lang, NewVersionStrings> = { en, hi };
