/**
 * S07-01 AC-1 — the QR's payload and its shape.
 *
 * What is asserted, and what is deliberately NOT:
 *
 *  - The **payload** is asserted exactly: the string a scanner would hand back
 *    is the plain guest URL. That is the part a wrong QR silently gets wrong.
 *  - The **output** is asserted structurally (an `<svg>` with a viewBox, no
 *    raster fallback), not by decoding it. Decoding would need a second QR
 *    dependency and would only prove the encoder agrees with itself; the real
 *    acceptance test for AC-1 is a scan on a phone, which is recorded in the
 *    close-out rather than pretended here.
 */
import { describe, expect, it } from "vitest";
import { LinkError } from "../../src/guest/links.ts";
import { qrPayload, qrSvg } from "../../src/guest/qr.ts";

describe("qrPayload", () => {
  it("is the guest URL and nothing else — no ids, no tracking, no signature", () => {
    expect(qrPayload({ baseUrl: "https://chat.example.com", slug: "casa-mesa" })).toBe(
      "https://chat.example.com/c/casa-mesa",
    );
  });

  it("keeps the language when one is asked for", () => {
    expect(qrPayload({ baseUrl: "https://chat.example.com", slug: "casa-mesa", lang: "en" })).toBe(
      "https://chat.example.com/c/casa-mesa?lang=en",
    );
  });
});

describe("qrSvg", () => {
  it("returns a scalable SVG with a viewBox and no fixed pixel size", async () => {
    const svg = await qrSvg({ baseUrl: "https://chat.example.com", slug: "casa-mesa" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox=");
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    // Print shops want vector; a rasterised QR is a QR that softens.
    expect(svg).not.toContain("<image");
  });

  it("survives a base URL long enough to matter (a preview host, a deep path)", async () => {
    const svg = await qrSvg({
      baseUrl: "https://abc12345-3000.e2b.app",
      slug: "casa-mesa",
    });
    expect(svg).toContain("viewBox=");
  });

  it("fails loudly rather than returning something that is not a QR", async () => {
    // An invalid slug cannot reach the encoder: the shared URL builder refuses
    // it first, so the route 404s instead of printing a card that scans nowhere.
    await expect(qrSvg({ baseUrl: "https://chat.example.com", slug: "../x" })).rejects.toThrow(
      LinkError,
    );
  });
});
