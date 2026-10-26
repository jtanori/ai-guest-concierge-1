import Link from "next/link";
import type { ReactNode } from "react";
import { currentLang, translator } from "@/lib/i18n";

/**
 * The staff frame (moved here by S06-01 so the public guest page stops
 * inheriting it). A route group changes no URL: `/review` and `/session` are
 * exactly where S04-01 put them.
 *
 * S08-01 adds the second surface, so the header stops naming the first one:
 * a shared brand plus a link to each surface. Every label is a catalogue id —
 * including the ones this file renders, which is why `staff.common.brand` was
 * added rather than reusing `staff.review.title` as the site name.
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
          <span className="text-sm font-semibold tracking-tight">{tr("staff.common.brand")}</span>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/inbox" className="text-muted-foreground hover:text-foreground">
              {tr("staff.inbox.title")}
            </Link>
            <Link href="/review" className="text-muted-foreground hover:text-foreground">
              {tr("staff.review.title")}
            </Link>
            {/* S08-04: the operating mode lives with the other staff surfaces. */}
            <Link href="/settings" className="text-muted-foreground hover:text-foreground">
              {tr("staff.mode.nav")}
            </Link>
            <span className="text-xs text-muted-foreground">{lang.toUpperCase()}</span>
          </nav>
        </div>
      </header>
      {/* S08-01: on a phone the staff surfaces are read standing up, so the
          page is one column and the padding is smaller below `sm`. */}
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </>
  );
}
