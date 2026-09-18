import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentFund — Budget-aware AI task planner",
  description:
    "Describe what you want to build, choose your model and budget, and AgentFund creates a realistic execution plan and optimized prompt for the task.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}