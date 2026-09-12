'use client';

import imageCompression from 'browser-image-compression';

import { MAX_IMAGE_BYTES } from './schemas';

/**
 * Resizes a photo to at most 800 px on the long side and re-encodes it as
 * WebP before upload (spec §4). Runs on the main thread: the library's web
 * worker would load its script from a CDN.
 */
export async function compressMenuImage(file: File, maxSide = 800): Promise<File> {
  const compressed = await imageCompression(file, {
    maxWidthOrHeight: maxSide,
    maxSizeMB: 0.5,
    fileType: 'image/webp',
    initialQuality: 0.8,
    useWebWorker: false,
  });
  if (compressed.size > MAX_IMAGE_BYTES) {
    throw new Error('This image is too large even after resizing. Try another photo.');
  }
  // Keep a File (with a name) so it travels in FormData the same way.
  return new File([compressed], `image.${compressed.type.split('/')[1] ?? 'webp'}`, {
    type: compressed.type,
  });
}
