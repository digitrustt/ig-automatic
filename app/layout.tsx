import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ig-automatic',
  description: 'Viral discovery and remix pipeline for Instagram Reels',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body>{children}</body>
    </html>
  );
}
