/**
 * S07-01 AC-1 — the QR code, as an SVG.
 *
 * A QR on a printed card is a promise that outlives the deployment: somebody
 * photographs it, prints it again, tapes it to a door. Three consequences shape
 * this file:
 *
 *  - **The payload is the plain guest URL.** Not a shortener, not a redirect
 *    with a tracking id, not a signed token. A code that leaks a tenant id leaks
 *    the shape of the system; a code that leaks the URL a guest could have typed
 *    leaks nothing.
 *  - **Error correction M, not L.** L is smaller and would survive a clean
 *    screen; a laminated card on a front desk gets scuffed, so M (15%) is the
 *    cheap insurance and the size cost is a few modules.
 *  - **SVG, not PNG.** It is text: the browser can scale it, the route can be
 *    cached by a CDN forever, and it does not need an image pipeline. Print shops
 *    want vector anyway.
 *
 * `qrcode` is a pure-JS encoder (`qrcode` + `@types/qrcode`, approved by the
 * operator 2026-10-25). It is used rather than a hand-rolled encoder because a
 * wrong QR is not a visible failure — it is a card that scans to nothing, and
 * nobody finds out until a guest is standing in a lobby.
 */
import QRCode from "qrcode";
import { chatUrl } from "./links.ts";

export interface QrOptions {
  /** Public origin of this deployment. */
  baseUrl: string;
  slug: string;
  lang?: string | null;
}

export class QrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrError";
  }
}

/** The exact string the code will encode. Exported so a test can prove it. */
export function qrPayload(options: QrOptions): string {
  return chatUrl(options.baseUrl, options.slug, options.lang);
}

export async function qrSvg(options: QrOptions): Promise<string> {
  const url = qrPayload(options);
  const svg = await QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    // Two modules of quiet zone: the spec asks for four, but a printed card
    // almost always has its own margin and four here wastes a third of a small
    // card. Two is the smallest value that scans reliably on paper.
    margin: 2,
    // `<svg>` with a viewBox and no fixed width: the card decides the size.
    width: undefined,
  });
  if (!svg.startsWith("<svg")) throw new QrError("qrcode did not return an SVG");
  return svg;
}
