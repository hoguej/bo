import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Bo - Family AI Assistant',
  description: 'Multi-tenant AI assistant platform',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
