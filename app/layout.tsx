import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'QR Lab · 本地二维码实验台', description: '在浏览器本地生成、扫描并检查 QR Code 技术信息。' };
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }
