import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Space_Grotesk } from 'next/font/google';
import './globals.css';
import { Shell } from '@/components/Shell';

const grotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-grotesk',
});

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
});

export const metadata: Metadata = {
  title: 'MemexOS Console',
  description: 'Trail Mesh console — read-only projection of the graph',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
