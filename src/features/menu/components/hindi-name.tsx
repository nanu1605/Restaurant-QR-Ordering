/**
 * The Hindi name shown after a dish or category name in the editor: the
 * owner's, else the automatic one, marked so the owner knows they can change it.
 */
export function HindiName({
  nameHi,
  nameHiAuto,
}: {
  nameHi: string | null;
  nameHiAuto: string | null;
}) {
  const name = nameHi ?? nameHiAuto;
  if (!name) return null;
  return (
    <>
      {' '}
      <span lang="hi" className="font-normal text-ink-muted">
        {name}
      </span>
      {!nameHi && <span className="text-xs font-normal text-ink-muted"> (auto)</span>}
    </>
  );
}
