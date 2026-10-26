import type { ReactNode } from "react";
import { currentLang, translator } from "@/lib/i18n";

/**
 * The staff frame (moved here by S06-01 so the public guest page stops
 * inheriting it). A route group changes no URL: `/review` and `/session` are
 * exactly where S04-01 put them.
 */
export default async function StaffLayout({
  children,
}: {
  children: ReactNode;
}): Promise<React.ReactElement> {
  const lang = await currentLang();
  const tr = translator(lang);
  return (
    <>
      <header className="border-b">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold tracking-tight">{tr("staff.review.title")}</span>
          <span className="text-xs text-muted-foreground">{lang.toUpperCase()}</span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
    </>
  );
}
