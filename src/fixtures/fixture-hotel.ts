/**
 * W00-17 — the adversarial fixture hotel, deliberately messy on purpose.
 *
 * Derived from plan §4 "The fixture hotel is adversarial on purpose": if
 * chunking, contradictions and the retrieval gate cannot survive these six
 * cases on the demo property, they will not survive a real hotel.
 *
 * This module carries DATA only: article versions (immutable, cited by
 * article_version_id per D5) and structured facts (per `property_facts`).
 * No schema, no retrieval, no chunking — those are S01+/S04, and Rule 1
 * holds this file to data.
 */

export interface FixtureArticleVersion {
  /** UUID-stable across fixtures (D5: citations resolve to versions, never articles) */
  articleVersionId: string;
  articleId: string;
  topicKey: string;
  language: string;
  isCurrent: boolean;
  title: string;
  /** null = the article's only content is a picture (the noticeboard case) */
  body: string | null;
  sourceNote: string;
}

export interface FixtureFact {
  factId: string;
  propertyId: "demo";
  topicKey: string;
  /** Logical key inside the topic (S03-03) - not the fixture id. */
  factKey: string;
  unit: string;
  value: string;
  language: string;
  effectiveFrom: string;
  sourceArticleVersionId: string;
  verified: boolean;
  sourceNote: string;
}

const VERSION = {
  menuPdf: "1f0a2a3b-0001-4c01-a1a1-000000000001",
  quietPolicy: "1f0a2a3b-0002-4c01-a1a1-000000000002",
  poolWebsite: "1f0a2a3b-0003-4c01-a1a1-000000000003",
  poolDirectory: "1f0a2a3b-0004-4c01-a1a1-000000000004",
  spaEs: "1f0a2a3b-0005-4c01-a1a1-000000000005",
  marketing: "1f0a2a3b-0006-4c01-a1a1-000000000006",
  noticeboard: "1f0a2a3b-0007-4c01-a1a1-000000000007",
  // S06-03 canary corpus expansion — topics the golden set asks about but the
  // original seven adversarial articles did not cover. Each is a clean,
  // retrievable article so retrieval can find an answer instead of returning
  // low_retrieval.
  petsPolicy: "1f0a2a3b-0008-4c01-a1a1-000000000008",
  diningHours: "1f0a2a3b-0009-4c01-a1a1-000000000009",
  wifiInfo: "1f0a2a3b-000a-4c01-a1a1-00000000000a",
  checkinHours: "1f0a2a3b-000b-4c01-a1a1-00000000000b",
  checkinPolicy: "1f0a2a3b-000c-4c01-a1a1-00000000000c",
  transportAirport: "1f0a2a3b-000d-4c01-a1a1-00000000000d",
  roomAmenities: "1f0a2a3b-000e-4c01-a1a1-00000000000e",
  parkingInfo: "1f0a2a3b-000f-4c01-a1a1-00000000000f",
} as const;

export const FIXTURE_PROPERTY = {
  propertyId: "demo",
  name: "Hotel Casa Mesa — adversarial fixture",
  languages: ["es", "en"] as const,
};

function buildFlattenedMenu(): string {
  // Two-column PDF menu flattened to text: dish names and prices run
  // together on single lines, column semantics destroyed.
  const dishes = [
    ["Ensalada de nopales", "$85"],
    ["Sopa azteca", "$95"],
    ["Tacos de cochinita pibil", "$120"],
    ["Pescado a la talla", "$180"],
    ["Mole poblano", "$165"],
    ["Pulpo al carbón", "$210"],
    ["Postre tres leches", "$70"],
    ["Fresa con crema", "$65"],
  ];
  return dishes.map(([name, price]) => `${name}   ${price}`).join("\n");
}

function buildMarketingArticle(heading: string): string {
  // 3,000+ words of marketing copy; the only useful fact — the gym is open
  // 24/7 — lands in paragraph 11. Deterministic, no randomness.
  const fillerSentences = [
    "Nestled between the FlexLine-toggler sunsets and the pearl-dark ocean, our rooms rewrite the grammar of escape.",
    "Every suite is a love letter to the tropics, stitched with artisan textiles and breeze-capable louvres.",
    "Guests drift from tiled daylight into an evening that tastes of salt and jasmine.",
    "Our sommelier-curated vermouth list glitters like a threat.",
    "The lobby smell — cedar, lime, rain — has its own fan club, and the concierge smiles like the weather is personal.",
    "Attention to detail is the house religion, first-pressed linens to the exact angle of the hammock.",
    "Children become tiny explorers; adults become amateurs of nothing.",
    "Rooftop conversations stretch until the streetlights surrender.",
    "Breakfast is a civic event with coffee serious enough to interrupt.",
    "The infinity pool holds the horizon like a held breath.",
  ];
  const parts: string[] = [heading];
  const filler = (n: number): string => {
    const sentence = fillerSentences[n % fillerSentences.length];
    return sentence ?? "";
  };
  // Paragraph 1 is the heading; paragraphs 2-10 are pure marketing.
  for (let i = 0; i < 9; i++) {
    const sentences: string[] = [];
    for (let j = 0; j < 24; j++) {
      sentences.push(filler(i * 3 + j));
    }
    parts.push(sentences.join(" "));
  }
  // Paragraph 11: the only useful fact in the whole document.
  parts.push(
    "One small detail we will not bury in prose: gym.hours is 24/7 — the fitness room never closes, keys at the lobby desk.",
  );
  // Paragraphs 12-14: resume the marketing.
  for (let i = 9; i < 12; i++) {
    const sentences: string[] = [];
    for (let j = 0; j < 5; j++) {
      sentences.push(filler(i * 2 + j));
    }
    parts.push(sentences.join(" "));
  }
  return parts.join("\n\n");
}

export const FIXTURE_ARTICLES: FixtureArticleVersion[] = [
  {
    articleVersionId: VERSION.menuPdf,
    articleId: "art-menu-dinner",
    topicKey: "dining.menu",
    language: "es",
    isCurrent: true,
    title: "Carta de cena (PDF exportado)",
    body: buildFlattenedMenu(),
    sourceNote: "Caso 1 — menú de dos columnas exportado a PDF: aplanado a una columna",
  },
  {
    articleVersionId: VERSION.quietPolicy,
    articleId: "art-quiet-policy",
    topicKey: "policy.quiet",
    language: "en",
    isCurrent: true,
    title: "Quiet hours (scan)",
    body: [
      "Chéck-out es la 11:00 AM — quict time fr0m 22:00 t0 8:00,",
      "please resp3ct the rûles, voice down in hallways,",
      "P4rties not permitido en las rooms durante quiet hrs.",
    ].join(" "),
    sourceNote: "Caso 2 — política escaneada con ruido OCR (document scanned, digits-for-letters)",
  },
  {
    articleVersionId: VERSION.poolWebsite,
    articleId: "art-pool-website",
    topicKey: "pool.hours",
    language: "es",
    isCurrent: true,
    title: "Horarios de la alberca (sitio web)",
    body: "La alberca está abierta todos los días de 07:00 a 21:00.",
    sourceNote: "Caso 3a — pool.hours según el sitio web (21:00)",
  },
  {
    articleVersionId: VERSION.poolDirectory,
    articleId: "art-pool-directory",
    topicKey: "pool.hours",
    language: "es",
    isCurrent: true,
    title: "Horarios de la alberca (guest directory)",
    body: "Pool hours: 07:00 – 20:00 daily.",
    sourceNote: "Caso 3b — pool.hours según el guest directory (20:00) — contradicts 3a",
  },
  {
    articleVersionId: VERSION.spaEs,
    articleId: "art-spa-services",
    topicKey: "spa.services",
    language: "es",
    isCurrent: true,
    title: "Servicios de spa",
    body: "Nuestro spa ofrece masajes, faciales y temazcal. Reservas en recepción.",
    sourceNote: "Caso 4 — cuerpo en español; la lista de precios llegó en francés (hecho en facts)",
  },
  {
    articleVersionId: VERSION.marketing,
    articleId: "art-marketing-hello",
    topicKey: "gym.hours",
    language: "en",
    isCurrent: true,
    title: "Welcome to Casa Mesa",
    body: buildMarketingArticle("Welcome to Casa Mesa"),
    sourceNote: "Caso 5 — 3,000 palabras de marketing; el único dato útil vive en el párrafo 11",
  },
  {
    articleVersionId: VERSION.noticeboard,
    articleId: "art-noticeboard",
    topicKey: "policy.parking",
    language: "es",
    isCurrent: true,
    title: "Aviso sobre estacionamiento",
    body: null,
    sourceNote: "Caso 6 — el único contenido es una foto de un tablero de avisos (sin texto extraíble)",
  },
  // ── S06-03 canary corpus expansion ──────────────────────────────────────────
  // These cover the golden set's answer-expected topics that the original seven
  // adversarial articles left with no retrievable source. Clean, single-topic
  // articles so retrieval can find an answer instead of returning low_retrieval.
  {
    articleVersionId: VERSION.petsPolicy,
    articleId: "art-pets-policy",
    topicKey: "policy.pets",
    language: "en",
    isCurrent: true,
    title: "Pet policy",
    body:
      "Pets are welcome at Hotel Casa Mesa. We allow dogs and cats up to 15 kg in designated pet-friendly rooms. " +
      "There is a one-time pet fee of $500 MXN per stay. Pets must be leashed in common areas and are not allowed " +
      "in the pool or spa. Please let reception know in advance if you are travelling with a pet so we can prepare " +
      "the right room.",
    sourceNote: "S06-03 — pet policy for golden set topic policy.pets",
  },
  {
    articleVersionId: VERSION.diningHours,
    articleId: "art-dining-hours",
    topicKey: "dining.hours",
    language: "en",
    isCurrent: true,
    title: "Restaurant and breakfast hours",
    body:
      "Breakfast is served daily from 7:00 to 11:00 AM in the main dining room. " +
      "The restaurant is open for lunch from 12:00 to 4:00 PM and for dinner from 6:00 to 10:30 PM. " +
      "Room service is available 24 hours. Breakfast includes a hot buffet, fresh fruit, pastries, and made-to-order eggs.",
    sourceNote: "S06-03 — dining hours for golden set topic dining.hours",
  },
  {
    articleVersionId: VERSION.wifiInfo,
    articleId: "art-wifi-info",
    topicKey: "wifi.info",
    language: "en",
    isCurrent: true,
    title: "Wi-Fi and internet access",
    body:
      "Free high-speed Wi-Fi is available in all rooms, the lobby, and all public areas. " +
      "The network name is CASA-MESA-GUEST and the password is provided at check-in. " +
      "There is no charge for Wi-Fi; it is included with every stay. " +
      "A wired ethernet connection is also available in the business centre.",
    sourceNote: "S06-03 — wifi info for golden set topic wifi.info",
  },
  {
    articleVersionId: VERSION.checkinHours,
    articleId: "art-checkin-hours",
    topicKey: "checkin.hours",
    language: "es",
    isCurrent: true,
    title: "Horarios de check-in y check-out",
    body:
      "El check-in comienza a las 15:00 (3:00 PM) y el check-out es a las 12:00 (mediodía). " +
      "Si llegas antes de las 15:00, podemos guardar tu equipaje en recepción sin costo. " +
      "El check-in tardío después de las 22:00 está permitido; por favor avísanos con anticipación.",
    sourceNote: "S06-03 — check-in hours for golden set topic checkin.hours",
  },
  {
    articleVersionId: VERSION.checkinPolicy,
    articleId: "art-checkin-policy",
    topicKey: "checkin.policy",
    language: "en",
    isCurrent: true,
    title: "Early check-in policy",
    body:
      "Early check-in before 15:00 is subject to availability and cannot be guaranteed. " +
      "If a room is ready, we are happy to allow early check-in at no extra charge. " +
      "If no room is available, we will store your luggage and you are welcome to use the pool and common areas. " +
      "To request early check-in, contact reception the day before your arrival or on the morning of check-in.",
    sourceNote: "S06-03 — early check-in policy for golden set topic checkin.policy",
  },
  {
    articleVersionId: VERSION.transportAirport,
    articleId: "art-transport-airport",
    topicKey: "transport.airport",
    language: "en",
    isCurrent: true,
    title: "Airport transfers",
    body:
      "The hotel offers a private airport transfer service. The cost is $800 MXN each way for up to 3 passengers " +
      "in a sedan, or $1,200 MXN each way for up to 6 passengers in a van. " +
      "The transfer takes approximately 35 minutes from the international airport. " +
      "To book a transfer, contact reception at least 24 hours before your arrival with your flight number and arrival time.",
    sourceNote: "S06-03 — airport transfer for golden set topic transport.airport",
  },
  {
    articleVersionId: VERSION.roomAmenities,
    articleId: "art-room-amenities",
    topicKey: "room.amenities",
    language: "es",
    isCurrent: true,
    title: "Camas extra y amenidades de habitación",
    body:
      "Podemos agregar una cama extra (cuna o cama plegable) por $350 MXN por noche, sujeta a disponibilidad. " +
      "Las habitaciones incluyen aire acondicionado, caja de seguridad, minibar y baño privado con amenities. " +
      "Cada habitación tiene capacidad máxima de 3 adultos o 2 adultos y 2 niños. " +
      "Por favor solicita la cama extra al momento de reservar o al menos 48 horas antes de tu llegada.",
    sourceNote: "S06-03 — extra bed policy for golden set topic room.amenities",
  },
  {
    articleVersionId: VERSION.parkingInfo,
    articleId: "art-parking-info",
    topicKey: "parking.info",
    language: "en",
    isCurrent: true,
    title: "Parking information",
    body:
      "Yes, the hotel has a secure underground parking garage. Parking costs $150 MXN per night for hotel guests. " +
      "The garage is open 24 hours and is monitored by cameras. " +
      "There is no charge for parking if you are dining at the restaurant. " +
      "The garage clearance is 2.1 metres; oversized vehicles should contact reception in advance.",
    sourceNote: "S06-03 — parking info for golden set topic parking.info",
  },
];

export const FIXTURE_FACTS: FixtureFact[] = [
  {
    factId: "fact-pool-website",
    propertyId: "demo",
    topicKey: "pool.hours",
    factKey: "closing_time",
    unit: "time-of-day",
    value: "21:00",
    language: "es",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.poolWebsite,
    verified: false,
    sourceNote: "Caso 3a — sitio web: cierra 21:00",
  },
  {
    factId: "fact-pool-directory",
    propertyId: "demo",
    topicKey: "pool.hours",
    factKey: "closing_time",
    unit: "time-of-day",
    value: "20:00",
    language: "es",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.poolDirectory,
    verified: false,
    sourceNote: "Caso 3b — guest directory: cierra 20:00 (contradicción)",
  },
  {
    factId: "fact-spa-massage-fr",
    propertyId: "demo",
    topicKey: "spa.services",
    factKey: "massage_60",
    unit: "currency-amount",
    value: "90 EUR / masaje 60 min",
    language: "fr",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.spaEs,
    verified: false,
    sourceNote: "Caso 4 — precio comunicado en francés; el cuerpo del artículo está en español",
  },
  {
    factId: "fact-spa-facial-fr",
    propertyId: "demo",
    topicKey: "spa.services",
    factKey: "facial",
    unit: "currency-amount",
    value: "75 EUR / limpia facial",
    language: "fr",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.spaEs,
    verified: false,
    sourceNote: "Caso 4 — precio comunicado en francés",
  },
  {
    factId: "fact-gym-hours",
    propertyId: "demo",
    topicKey: "gym.hours",
    factKey: "hours",
    unit: "hours",
    value: "24/7",
    language: "en",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.marketing,
    verified: false,
    sourceNote: "Caso 5 — el dato útil enterrado en el párrafo 11 del artículo de marketing",
  },
  // ── S06-03 canary corpus expansion — structured facts for the golden set ────
  {
    factId: "fact-dining-breakfast",
    propertyId: "demo",
    topicKey: "dining.hours",
    factKey: "breakfast_hours",
    unit: "hours",
    value: "7:00-11:00 AM",
    language: "en",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.diningHours,
    verified: false,
    sourceNote: "S06-03 — breakfast hours for golden set",
  },
  {
    factId: "fact-parking-rate",
    propertyId: "demo",
    topicKey: "parking.info",
    factKey: "nightly_rate",
    unit: "currency-amount",
    value: "$150 MXN per night",
    language: "en",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.parkingInfo,
    verified: false,
    sourceNote: "S06-03 — parking rate for golden set",
  },
  {
    factId: "fact-transport-airport-sedan",
    propertyId: "demo",
    topicKey: "transport.airport",
    factKey: "sedan_price",
    unit: "currency-amount",
    value: "$800 MXN each way",
    language: "en",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.transportAirport,
    verified: false,
    sourceNote: "S06-03 — airport transfer sedan price for golden set",
  },
  {
    factId: "fact-room-extra-bed",
    propertyId: "demo",
    topicKey: "room.amenities",
    factKey: "extra_bed_rate",
    unit: "currency-amount",
    value: "$350 MXN per night",
    language: "es",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.roomAmenities,
    verified: false,
    sourceNote: "S06-03 — extra bed rate for golden set",
  },
  {
    factId: "fact-checkin-time",
    propertyId: "demo",
    topicKey: "checkin.hours",
    factKey: "checkin_time",
    unit: "time-of-day",
    value: "15:00",
    language: "es",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.checkinHours,
    verified: false,
    sourceNote: "S06-03 — check-in time for golden set",
  },
  {
    factId: "fact-wifi-cost",
    propertyId: "demo",
    topicKey: "wifi.info",
    factKey: "cost",
    unit: "text",
    value: "free",
    language: "en",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.wifiInfo,
    verified: false,
    sourceNote: "S06-03 — wifi is free for golden set",
  },
];

/**
 * The case-by-case contract for "every messy case is reproducible":
 * the validation script and tests assert each of these independently.
 */
export const MESSY_CASES = [
  {
    id: "menu-flattened-two-column",
    articleVersionId: VERSION.menuPdf,
    whatBreaks: "a plain two-column PDF flattens into interleaved one-line pairs; requirement: menu rows stay on single lines, dish/price adjacent (this is extractable, but only structurally)",
  },
  {
    id: "ocr-noise-scan",
    articleVersionId: VERSION.quietPolicy,
    whatBreaks: "machine-extracted text carries digits-for-letters substitutions («Chéck0ut», «fr0m», «res3ct»)",
  },
  {
    id: "contradiction-pool-hours",
    articleVersionId: VERSION.poolWebsite,
    whatBreaks: "two verified=false facts share topicKey=pool.hours AND factKey=closing_time (same effective date) with different values (21:00 vs 20:00); onboarding must refuse to resolve silently — G1 requires zero unresolved contradictions",
  },
  {
    id: "spa-prices-foreign-language",
    articleVersionId: VERSION.spaEs,
    whatBreaks: "facts arrive in fr while the article body is es; language mismatch must flag review, never auto-merge",
  },
  {
    id: "marketing-fact-buried-paragraph-11",
    articleVersionId: VERSION.marketing,
    whatBreaks: "≥3,000 words where the sole useful fact sits in paragraph 11; extraction must see past the prose",
  },
  {
    id: "noticeboard-picture-only",
    articleVersionId: VERSION.noticeboard,
    whatBreaks: "body is null — nothing to chunk or embed; the version must remain citable while retrieval yields nothing from it",
  },
] as const;
