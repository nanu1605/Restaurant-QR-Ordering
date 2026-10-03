/** "हिन्दी" inside English copy, marked as Hindi for screen readers. */
export function WithHindi({ text }: { text: string }) {
  const [before, after] = text.split('हिन्दी');
  if (after === undefined) return text;
  return (
    <>
      {before}
      <span lang="hi">हिन्दी</span>
      {after}
    </>
  );
}
