/**
 * Public URLs for menu images and logos (public-read buckets, spec §9.1). The
 * version query (the row's updated_at) makes browsers fetch a replaced image,
 * since each item keeps one path.
 */
export function publicImageUrl(
  supabaseUrl: string,
  bucket: 'menu-images' | 'logos',
  path: string,
  version?: string | null,
): string {
  const base = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${path}`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}
