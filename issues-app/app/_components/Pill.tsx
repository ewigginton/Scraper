import type { PillColor } from '../_lib/pills.ts';

interface PillProps {
  color: PillColor;
  children: React.ReactNode;
  className?: string;
}

/** Soft Notion-style colored pill (docs/notion-redesign.md "Pills/tags"). Color comes from app/_lib/pills.ts's mapping — never chosen ad hoc at the call site. */
export function Pill({ color, children, className }: PillProps) {
  return <span className={`n-pill n-pill-${color}${className ? ` ${className}` : ''}`}>{children}</span>;
}
