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
            __html: `(function(){try{var c=(typeof crypto!=='undefined'&&crypto)||(typeof window!=='undefined'&&window.crypto);if(c&&typeof c.randomUUID!=='function'&&typeof c.getRandomValues==='function'){var hx=[];for(var i=0;i<256;i++){hx[i]=(i+256).toString(16).slice(1)}c.randomUUID=function(){var b=c.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;return hx[b[0]]+hx[b[1]]+hx[b[2]]+hx[b[3]]+'-'+hx[b[4]]+hx[b[5]]+'-'+hx[b[6]]+hx[b[7]]+'-'+hx[b[8]]+hx[b[9]]+'-'+hx[b[10]]+hx[b[11]]+hx[b[12]]+hx[b[13]]+hx[b[14]]+hx[b[15]]}}}catch(e){}})();(function(){try{var t=localStorage.getItem('openryoko-theme')||localStorage.getItem('jinn-theme')||'ryoko';if(t==='system'){t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'ryoko'}document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`,
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
