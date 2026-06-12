import type { Metadata } from 'next';
import './globals.css';
import { StatusRibbon } from '@/components/StatusRibbon';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: 'MemexOS Console',
  description: 'Trail Mesh console — read-only projection of the graph',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StatusRibbon />
        <div className="flex">
          <Nav />
          <main className="flex-1 p-4 min-h-screen">{children}</main>
        </div>
      </body>
    </html>
  );
}
