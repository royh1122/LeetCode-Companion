import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Sidebar } from "@/components/sidebar";
import { connection } from "next/server";
import { getRevision } from "@lcc/db";
import { LiveRefresh } from "@/components/live-refresh";
import { db } from "@/lib/server";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "LeetCode Companion", template: "%s · LeetCode Companion" },
  description: "Local-first LeetCode practice dashboard",
};

const themeScript = `(function(){try{var t=localStorage.getItem("lcc-theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}})()`;

/** Read per request (never at build time), so it is the revision the page was rendered from. */
async function CurrentRevision() {
  await connection();
  return <LiveRefresh revision={getRevision(db())} />;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      {/* Extensions like Grammarly add attributes to <body> before hydration; ignore those (this element only). */}
      <body className="min-h-screen font-sans text-sm" suppressHydrationWarning>
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="min-w-0 flex-1">
            <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-14 md:px-8 md:py-8">{children}</div>
          </main>
        </div>
        <CurrentRevision />
      </body>
    </html>
  );
}
