import type { Metadata } from "next";
import type { ReactNode } from "react";
import { currentLang, translator } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "Concierge · Staff",
  description: "Review queue for the hotel's AI concierge",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<React.ReactElement> {
  const lang = await currentLang();
  const tr = translator(lang);
  return (
    <html lang={lang}>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <header className="border-b">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
            <span className="text-sm font-semibold tracking-tight">{tr("staff.review.title")}</span>
            <span className="text-xs text-muted-foreground">{lang.toUpperCase()}</span>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
