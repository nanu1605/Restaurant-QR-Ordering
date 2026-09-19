import 'server-only';

import { getServerEnv, type ServerEnv } from '@/lib/env.server';
import type { VisionProvider } from '@/lib/vision/openai-compatible';

/** A readable label for the import record: the provider's host without "api.". */
function providerName(baseUrl: string): string {
  const host = new URL(baseUrl).hostname.replace(/^api\./, '');
  return host.split('.').slice(0, -1).join('.') || host;
}

/**
 * The configured readers, primary first (docs/DECISIONS.md P7-12). Photo
 * import is offered only when there is at least one (spec §20A.6).
 */
export function menuImportProviders(env: ServerEnv = getServerEnv()): VisionProvider[] {
  const providers: VisionProvider[] = [];
  if (env.MENU_IMPORT_API_KEY) {
    providers.push({
      name: providerName(env.MENU_IMPORT_BASE_URL),
      baseUrl: env.MENU_IMPORT_BASE_URL,
      apiKey: env.MENU_IMPORT_API_KEY,
      model: env.MENU_IMPORT_MODEL,
    });
  }
  if (env.MENU_IMPORT_FALLBACK_API_KEY) {
    providers.push({
      name: providerName(env.MENU_IMPORT_FALLBACK_BASE_URL),
      baseUrl: env.MENU_IMPORT_FALLBACK_BASE_URL,
      apiKey: env.MENU_IMPORT_FALLBACK_API_KEY,
      model: env.MENU_IMPORT_FALLBACK_MODEL,
    });
  }
  return providers;
}

export function isPhotoImportEnabled(): boolean {
  return menuImportProviders().length > 0;
}
