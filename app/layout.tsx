import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Web Dev Agent',
  description: 'Build, preview, and download sandbox projects with an AI agent.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
