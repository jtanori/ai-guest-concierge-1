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
];

export const FIXTURE_FACTS: FixtureFact[] = [
  {
    factId: "fact-pool-website",
    propertyId: "demo",
    topicKey: "pool.hours",
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
    unit: "hours",
    value: "24/7",
    language: "en",
    effectiveFrom: "2026-01-01",
    sourceArticleVersionId: VERSION.marketing,
    verified: false,
    sourceNote: "Caso 5 — el dato útil enterrado en el párrafo 11 del artículo de marketing",
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
    whatBreaks: "two verified=false facts share topicKey=pool.hours with different values (21:00 vs 20:00); onboarding must refuse to resolve silently — G1 requires zero unresolved contradictions",
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
