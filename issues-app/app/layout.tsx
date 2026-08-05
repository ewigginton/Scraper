import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from './_components/Sidebar.tsx';

export const metadata: Metadata = {
  title: 'CCL Hub — Issues',
  description: 'Property Operations case management',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="n-shell">
          <Sidebar />
          <div className="n-content">
            <main className="n-content-inner">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
