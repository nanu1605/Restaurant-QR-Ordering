/**
 * Terms, privacy, refunds and shipping (spec §17, docs/DECISIONS.md P10-5,
 * W-2), inside the website's header and footer. The text is a placeholder
 * outline until the owner supplies the real policies.
 */
export default function LegalLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-12 sm:px-6">
      <p
        role="note"
        className="rounded-lg border border-attention/40 bg-attention/5 px-4 py-3 text-sm font-medium text-ink"
      >
        Placeholder — replace before launch. The headings below are an outline for the final text.
      </p>
      <article className="flex flex-col gap-5 text-base text-ink [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-semibold [&_p]:text-ink-muted [&_section]:flex [&_section]:flex-col [&_section]:gap-1.5">
        {children}
      </article>
    </div>
  );
}
