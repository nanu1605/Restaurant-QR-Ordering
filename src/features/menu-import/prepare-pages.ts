/**
 * Turns the files an owner picks into page photos, in the browser, before
 * anything is uploaded (spec §20A.1 step 1, docs/DECISIONS.md P7-14): each
 * photo or PDF page becomes a JPEG with a long edge of about 1600 px at 85%
 * quality. Photos narrower than 800 px are refused. PDF pages are rendered
 * with pdf.js, loaded only when a PDF is picked.
 */

export const LONG_EDGE_PX = 1600;
export const MIN_PAGE_WIDTH_PX = 800;
const JPEG_QUALITY = 0.85;

export const TOO_SMALL =
  'This photo is too small to read. Take a closer photo of one page at a time.';
export const CANT_OPEN =
  "This photo format can't be opened here. Export it as a JPEG, or upload it from your phone.";

export class PagePrepError extends Error {}

export type PreparedPage = {
  blob: Blob;
  /** Object URL for the preview; revoke it when the page is removed. */
  previewUrl: string;
  /** "menu.pdf, page 2" or the photo's file name. */
  label: string;
};

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new PagePrepError(CANT_OPEN))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

function scaledCanvas(width: number, height: number): HTMLCanvasElement {
  const scale = Math.min(1, LONG_EDGE_PX / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

export async function preparePhoto(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new PagePrepError(CANT_OPEN);
  }
  try {
    if (bitmap.width < MIN_PAGE_WIDTH_PX) throw new PagePrepError(TOO_SMALL);
    const canvas = scaledCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new PagePrepError(CANT_OPEN);
    // JPEG has no transparency: a transparent PNG would turn black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasToJpeg(canvas);
  } finally {
    bitmap.close();
  }
}

type PdfJs = typeof import('pdfjs-dist');
let pdfjsLoading: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsLoading ??= import('pdfjs-dist').then((pdfjs) => {
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(
        new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
        { type: 'module' },
      );
    }
    return pdfjs;
  });
  return pdfjsLoading;
}

/** Every page of a PDF as a JPEG. Refuses a PDF with more pages than `maxPages`. */
export async function preparePdf(file: File, maxPages: number): Promise<Blob[]> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let document_;
  try {
    document_ = await task.promise;
  } catch {
    await task.destroy();
    throw new PagePrepError('it could not be opened as a PDF.');
  }
  try {
    if (document_.numPages > maxPages) {
      throw new PagePrepError(
        `it has ${document_.numPages} pages and the import has room for ${maxPages}. Split it, or photograph the pages you need.`,
      );
    }
    const pages: Blob[] = [];
    for (let number = 1; number <= document_.numPages; number += 1) {
      const page = await document_.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: LONG_EDGE_PX / Math.max(natural.width, natural.height),
      });
      const canvas = scaledCanvas(viewport.width, viewport.height);
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      pages.push(await canvasToJpeg(canvas));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/**
 * The pages of the picked files, in order. `room` is how many more pages the
 * import can take; a file that would go over it is refused whole.
 */
export async function prepareFiles(
  files: File[],
  room: number,
): Promise<{ pages: PreparedPage[]; errors: string[] }> {
  const pages: PreparedPage[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const blobs = isPdf(file)
        ? await preparePdf(file, room - pages.length)
        : [await preparePhoto(file)];
      if (pages.length + blobs.length > room) {
        throw new PagePrepError('an import takes at most 10 pages, so it was left out.');
      }
      blobs.forEach((blob, index) =>
        pages.push({
          blob,
          previewUrl: URL.createObjectURL(blob),
          label: blobs.length > 1 ? `${file.name}, page ${index + 1}` : file.name,
        }),
      );
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof PagePrepError ? error.message : CANT_OPEN}`);
    }
  }
  return { pages, errors };
}
