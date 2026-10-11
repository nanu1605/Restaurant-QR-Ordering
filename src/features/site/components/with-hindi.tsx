import { Fragment } from 'react';

/** Each "हिन्दी" inside English copy, marked as Hindi for screen readers. */
export function WithHindi({ text }: { text: string }) {
  const [first, ...rest] = text.split('हिन्दी');
  if (!rest.length) return text;
  return (
    <>
      {first}
      {rest.map((part, index) => (
        <Fragment key={index}>
          <span lang="hi">हिन्दी</span>
          {part}
        </Fragment>
      ))}
    </>
  );
}
