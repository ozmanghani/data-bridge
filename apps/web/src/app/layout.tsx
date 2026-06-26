import type { Metadata } from 'next';
import { Providers } from '@/components/providers';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'Data Bridge — Sync any databases, live',
  description:
    'Keep any databases in sync across engines — PostgreSQL, MySQL, SQLite, MongoDB, Redis — in real time with CDC, polling, or one-shot replay. HTTP endpoints supported too.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground h-screen overflow-hidden antialiased">
        <Providers>{children}</Providers>
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
