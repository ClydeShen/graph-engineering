'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const PAGES = [
  { href: '/topology', label: 'Topology' },
  { href: '/kernel', label: 'Kernel' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/artifacts', label: 'Artifacts' },
  { href: '/skills', label: 'Skills' },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="w-36 shrink-0 border-r border-line min-h-screen p-2 space-y-1">
      {PAGES.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          className={`block px-3 py-1.5 rounded ${
            path.startsWith(p.href) ? 'bg-line text-gray-100' : 'hover:bg-panel'
          }`}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
