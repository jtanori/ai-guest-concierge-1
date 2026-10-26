import type { Metadata } from "next";
import type { ReactNode } from "react";
import { currentLang } from "@/lib/i18n";
import "./globals.css";

/**
 * S06-01 moved the staff chrome into `app/(staff)/layout.tsx`: the guest chat is
 * a PUBLIC page and must not inherit a header that says "Review queue" and a
 * language chip a stranger did not choose. The root layout keeps only what both
 * surfaces agree on — the document, the language and the theme.
 */
export const metadata: Metadata = {
  title: "Concierge",
  description: "Ask the hotel's concierge",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<React.ReactElement> {
  const lang = await currentLang();
  return (
    <html lang={lang}>
      <body className="min-h-dvh bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
