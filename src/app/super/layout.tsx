/**
 * No guard here: /super/mfa must open for a platform admin who hasn't entered
 * the second factor yet. The (panel) layout and every page guard themselves.
 */
export default function SuperLayout({ children }: LayoutProps<'/super'>) {
  return <div className="flex flex-1 flex-col">{children}</div>;
}
