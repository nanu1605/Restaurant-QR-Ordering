'use client';

import { Camera, FileSpreadsheet, ImagePlus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/browser';

import { startCsvImport, startPhotoImport } from '../actions';
import { CSV_COLUMNS, MAX_CSV_BYTES, type CsvError } from '../csv-reader';
import { MAX_IMPORT_PAGES } from '../draft';
import { prepareFiles, type PreparedPage } from '../prepare-pages';

const IMPORT_BUCKET = 'menu-imports';
const SAMPLE_CSV = [
  CSV_COLUMNS.join(','),
  'Starters,Paneer Tikka,"Cottage cheese, peppers, onion",veg,280,,',
  'Starters,Chicken 65,,non_veg,,Half,180',
  'Starters,Chicken 65,,non_veg,,Full,320',
  'Breads,Butter Naan,,veg,60,,',
].join('\n');

type ImportStartProps = {
  restaurantId: string;
  /** Where an import opens: `${importBasePath}/${importId}`. */
  importBasePath: string;
  /** False when no reader is configured (spec §20A.6): CSV only. */
  photoEnabled: boolean;
};

/** Choose how to import: photos or a PDF of the printed menu, or a CSV file (spec §20A.1). */
export function ImportStart({ restaurantId, importBasePath, photoEnabled }: ImportStartProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {photoEnabled ? (
        <PhotoImport restaurantId={restaurantId} importBasePath={importBasePath} />
      ) : (
        <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <Camera aria-hidden className="size-4" /> From photos
          </h2>
          <p className="text-sm text-ink-muted">
            Reading menus from photos is not set up yet. Import a CSV file, or add dishes on the
            Menu page.
          </p>
        </section>
      )}
      <CsvImport restaurantId={restaurantId} importBasePath={importBasePath} />
    </div>
  );
}

function PhotoImport({ restaurantId, importBasePath }: Omit<ImportStartProps, 'photoEnabled'>) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState<PreparedPage[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const busy = preparing || pending;

  // Previews are object URLs: let them go when the page leaves.
  const pagesRef = useRef(pages);
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);
  useEffect(
    () => () => pagesRef.current.forEach((page) => URL.revokeObjectURL(page.previewUrl)),
    [],
  );

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setPreparing(true);
    setErrors([]);
    const prepared = await prepareFiles(Array.from(files), MAX_IMPORT_PAGES - pages.length);
    setPages((current) => [...current, ...prepared.pages]);
    setErrors(prepared.errors);
    setPreparing(false);
    if (inputRef.current) inputRef.current.value = '';
  }

  function removePage(index: number) {
    setPages((current) => {
      URL.revokeObjectURL(current[index]!.previewUrl);
      return current.filter((_, i) => i !== index);
    });
  }

  function upload() {
    startTransition(async () => {
      setErrors([]);
      setStatus('Starting…');
      const started = await startPhotoImport(restaurantId, pages.length);
      if (!started.ok) {
        setStatus(null);
        setErrors([started.error]);
        return;
      }
      const storage = createClient().storage.from(IMPORT_BUCKET);
      for (const [index, upload] of started.data.uploads.entries()) {
        setStatus(`Uploading page ${index + 1} of ${pages.length}…`);
        const { error } = await storage.uploadToSignedUrl(
          upload.path,
          upload.token,
          pages[index]!.blob,
          { contentType: 'image/jpeg' },
        );
        if (error) {
          setStatus(null);
          setErrors([`Page ${index + 1} did not upload. Check the connection and try again.`]);
          return;
        }
      }
      setStatus('Opening…');
      router.push(`${importBasePath}/${started.data.importId}`);
    });
  }

  return (
    <section
      aria-labelledby={`${inputId}-title`}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <h2
        id={`${inputId}-title`}
        className="flex items-center gap-2 text-base font-semibold text-ink"
      >
        <Camera aria-hidden className="size-4" /> From photos or a PDF
      </h2>
      <p className="text-sm text-ink-muted">
        Take a photo of each page of the printed menu, straight on and in good light, or pick a PDF.
        Up to {MAX_IMPORT_PAGES} pages. You check everything before it goes on the menu.
      </p>

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="sr-only"
        aria-label="Menu photos or PDF"
        disabled={busy || pages.length >= MAX_IMPORT_PAGES}
        onChange={(event) => void addFiles(event.target.files)}
      />
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={busy || pages.length >= MAX_IMPORT_PAGES}
        onClick={() => inputRef.current?.click()}
      >
        <ImagePlus aria-hidden />
        {pages.length === 0 ? 'Choose photos or a PDF' : 'Add more pages'}
      </Button>

      {preparing && <p className="text-sm text-ink-muted">Preparing pages…</p>}

      {pages.length > 0 && (
        <ol aria-label="Pages to read" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {pages.map((page, index) => (
            <li key={page.previewUrl} className="relative flex flex-col gap-1">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL */}
              <img
                src={page.previewUrl}
                alt={`Page ${index + 1}: ${page.label}`}
                className="aspect-[3/4] w-full rounded-md border border-line bg-muted object-cover"
              />
              <span className="truncate text-xs text-ink-muted">Page {index + 1}</span>
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                className="absolute top-1 right-1"
                aria-label={`Remove page ${index + 1}`}
                disabled={busy}
                onClick={() => removePage(index)}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
      )}

      <ErrorList errors={errors} />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={busy || pages.length === 0} onClick={upload}>
          {pages.length === 1
            ? 'Read 1 page'
            : `Read ${pages.length > 0 ? `${pages.length} ` : ''}pages`}
        </Button>
        {status && (
          <p role="status" className="text-sm text-ink-muted">
            {status}
          </p>
        )}
      </div>
    </section>
  );
}

function CsvImport({ restaurantId, importBasePath }: Omit<ImportStartProps, 'photoEnabled'>) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<CsvError[]>([]);
  const [moreErrors, setMoreErrors] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function readFile(file: File | undefined) {
    if (!file) return;
    startTransition(async () => {
      setErrors([]);
      setMoreErrors(0);
      setMessage(null);
      if (file.size > MAX_CSV_BYTES) {
        setMessage('The file is larger than 1 MB. Split it into smaller files.');
        return;
      }
      const result = await startCsvImport(restaurantId, await file.text());
      if (inputRef.current) inputRef.current.value = '';
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      if (result.data.kind === 'invalid') {
        setMessage('Fix these rows in the file and choose it again. Nothing was imported.');
        setErrors(result.data.errors);
        setMoreErrors(result.data.moreErrors);
        return;
      }
      router.push(`${importBasePath}/${result.data.importId}`);
    });
  }

  return (
    <section
      aria-labelledby={`${inputId}-title`}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <h2
        id={`${inputId}-title`}
        className="flex items-center gap-2 text-base font-semibold text-ink"
      >
        <FileSpreadsheet aria-hidden className="size-4" /> From a CSV file
      </h2>
      <p className="text-sm text-ink-muted">
        A spreadsheet saved as CSV, with the columns{' '}
        <span className="font-mono text-xs text-ink">{CSV_COLUMNS.join(', ')}</span>. Rows with the
        same dish name and a <span className="font-mono text-xs text-ink">variant_name</span> become
        its options (Half, Full). <span className="font-mono text-xs text-ink">food_type</span> is
        veg, non_veg or egg.
      </p>
      <a
        href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`}
        download="menu-sample.csv"
        className="self-start text-sm font-medium text-brand underline-offset-4 hover:underline"
      >
        Download a sample CSV
      </a>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        aria-label="Menu CSV file"
        disabled={pending}
        onChange={(event) => readFile(event.target.files?.[0])}
      />
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
      >
        <FileSpreadsheet aria-hidden />
        {pending ? 'Reading the file…' : 'Choose a CSV file'}
      </Button>

      {message && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {message}
        </p>
      )}
      {errors.length > 0 && (
        <ul aria-label="Rows to fix" className="flex flex-col gap-1 text-sm text-ink">
          {errors.map((error, index) => (
            <li key={index}>{error.message}</li>
          ))}
          {moreErrors > 0 && (
            <li className="text-ink-muted">
              …and {moreErrors} more {moreErrors === 1 ? 'row' : 'rows'}.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function ErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul role="alert" className="flex flex-col gap-1 text-sm font-medium text-destructive">
      {errors.map((error) => (
        <li key={error}>{error}</li>
      ))}
    </ul>
  );
}
