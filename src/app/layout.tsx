import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Promgent — Your AI software-building guide",
  description:
    "Shape, plan, build, review, and improve a software project with one context-aware senior engineering guide powered by Orbio.",
  applicationName: "Promgent",
  icons: {
    icon: [{ url: "/promgent-icon.png", type: "image/png", sizes: "192x192" }],
    shortcut: "/promgent-icon.png",
    apple: [{ url: "/promgent-icon.png", type: "image/png", sizes: "192x192" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;1,6..72,300&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
