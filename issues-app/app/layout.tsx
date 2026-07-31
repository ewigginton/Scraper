import type { Metadata } from 'next';
import './globals.css';

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
        <header style={{ borderBottom: '1px solid var(--color-border)', padding: 'var(--space-lg)' }}>
          <div className="container">
            <h1 style={{ marginBottom: 'var(--space-md)' }}>CCL Hub — Issues</h1>
            <nav style={{ display: 'flex', gap: 'var(--space-lg)' }}>
              <a href="/">My Work</a>
              <a href="/issues/new">New Issue</a>
            </nav>
          </div>
        </header>
        <main style={{ padding: 'var(--space-lg)' }}>
          <div className="container">
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}
