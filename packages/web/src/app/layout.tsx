import type { Metadata, Viewport } from "next"
import { ClientProviders } from "./client-providers"
import "./globals.css"

export const metadata: Metadata = {
  title: "OpenRyoko",
  description: "OpenRyoko — Slackで空気を読んで働くAIゲートウェイ",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('openryoko-theme')||localStorage.getItem('jinn-theme')||'ryoko';if(t==='system'){t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'ryoko'}document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`,
          }}
        />
      </head>
      <body>
        <ClientProviders>
          {children}
        </ClientProviders>
      </body>
    </html>
  )
}
