/** Memex logo mark — ported from the design bundle's assets/logo-mark.svg. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Memex">
      <g stroke="currentColor" strokeWidth="1.4" opacity="0.9">
        <path d="M11 33 L24 13" />
        <path d="M24 13 L37 27" />
        <path d="M11 33 L37 27" />
        <path d="M24 13 L24 34" />
        <path d="M11 33 L24 34" />
        <path d="M37 27 L24 34" />
      </g>
      <circle cx="24" cy="13" r="4.2" fill="var(--brass-500)" stroke="var(--bg-base)" strokeWidth="1.4" />
      <circle cx="11" cy="33" r="3.1" fill="var(--patina-500)" />
      <circle cx="37" cy="27" r="3.1" fill="var(--glacier-500)" />
      <circle cx="24" cy="34" r="3.1" fill="var(--moss-500)" />
    </svg>
  );
}
