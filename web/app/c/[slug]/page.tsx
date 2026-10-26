import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuestChat } from "@/components/guest-chat";
import type { ApiFailure, PublicPropertyWire } from "@/lib/guest";
import { apiBase } from "@/lib/session";
import { currentLang, normalizeLang, translator } from "@/lib/i18n";

/**
 * S06-01 — `GET /c/:propertySlug`, the pilot surface.
 *
 * The page is a thin server-rendered shell: it resolves the slug through the
 * guest API (which is the only thing that can turn a slug into a tenant, and it
 * does so with the restricted `concierge_public` role — 0015), then hands the
 * browser a client component that talks only to this origin.
 *
 * WHY the property lookup happens here and not in the component: an unknown slug
 * must be a real 404 with the server's status, not a spinner that never resolves.
 */
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ lang?: string }>;
}

async function loadProperty(slug: string, lang: string): Promise<PublicPropertyWire | null> {
  try {
    const response = await fetch(
      `${apiBase()}/api/chat/property?property=${encodeURIComponent(slug)}&lang=${encodeURIComponent(lang)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as PublicPropertyWire | ApiFailure;
    return "slug" in body ? body : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${slug} · Concierge` };
}

export default async function GuestPropertyPage({
  params,
  searchParams,
}: Params): Promise<React.ReactElement> {
  const { slug } = await params;
  const lang = normalizeLang((await searchParams).lang ?? (await currentLang()));
  const tr = translator(lang);

  const property = await loadProperty(slug, lang);
  if (property === null) notFound();

  return (
    <GuestChat
      slug={property.slug}
      lang={lang}
      propertyName={property.name}
      labels={{
        heading: tr("guest.chat.heading"),
        empty: tr("guest.chat.empty"),
        placeholder: tr("guest.chat.placeholder"),
        send: tr("guest.chat.send"),
        error: tr("guest.chat.error"),
        // AC-3: the API is the source of these two strings so the page and the
        // transcript cannot disagree about what was disclosed.
        disclosure: property.disclosure,
        talkToPerson: property.talkToPerson,
      }}
      handoffMessage={property.talkToPerson}
    />
  );
}
