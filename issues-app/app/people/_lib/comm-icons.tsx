/**
 * Small inline-SVG icon set for communication channels, scoped to /people
 * (this lane may not edit the shared app/_components/icons.tsx — see the
 * Wave 2a concurrency rules). Mirrors that file's stroke-based, currentColor
 * IconBase pattern so a future port can fold these in without a visual
 * change, same duplication rationale as scripts/demo-seed-comms.ts's copied
 * SeededRandom.
 */

export interface CommIconProps {
  size?: number;
  className?: string;
}

function IconBase({ size = 14, className, children }: CommIconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function CallIcon(props: CommIconProps) {
  return (
    <IconBase {...props}>
      <path d="M3.5 2.5h2l1 3-1.5 1a8 8 0 0 0 4.5 4.5l1-1.5 3 1v2c0 .8-.7 1.4-1.5 1.3a11.5 11.5 0 0 1-9.9-9.9c-.1-.8.5-1.4 1.3-1.4z" />
    </IconBase>
  );
}

export function TextIcon(props: CommIconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5H4A1.5 1.5 0 0 1 2.5 9z" />
    </IconBase>
  );
}

export function EmailIcon(props: CommIconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.2" />
      <path d="M2.9 4.2l5.1 4 5.1-4" />
    </IconBase>
  );
}

export function VoicemailIcon(props: CommIconProps) {
  return (
    <IconBase {...props}>
      <circle cx="4.5" cy="9" r="2.2" />
      <circle cx="11.5" cy="9" r="2.2" />
      <path d="M4.5 6.8h7" />
    </IconBase>
  );
}

export function NoticeIcon(props: CommIconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 2.5h6l2 2v9H4z" />
      <path d="M6 7h4M6 9.5h4" />
    </IconBase>
  );
}

export function OtherIcon(props: CommIconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.5v3M8 10.5h.01" />
    </IconBase>
  );
}

export function commIconFor(channel: string) {
  switch (channel) {
    case 'call':
      return CallIcon;
    case 'text':
      return TextIcon;
    case 'email':
      return EmailIcon;
    case 'voicemail':
      return VoicemailIcon;
    case 'notice':
      return NoticeIcon;
    default:
      return OtherIcon;
  }
}
