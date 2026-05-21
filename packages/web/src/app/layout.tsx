import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'GCPoker',
  description: 'Online Poker with Minecraft Economy',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ margin: 0, padding: 0, overflow: 'hidden' }}>
      <body style={{ margin: 0, padding: 0, fontFamily: 'system-ui, sans-serif', background: '#0f0f1a', color: '#e8e8e8', overflow: 'hidden' }}>
        {children}
      </body>
    </html>
  )
}
