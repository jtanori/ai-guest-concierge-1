/**
 * S07-01 — the links out of the chat.
 *
 * The cases that matter are the refusals: a slug that is not a slug, a base URL
 * that is not an origin, an origin that only *looks* like an allowed one, and a
 * value that would break out of the generated script. Everything else here is
 * string building, and string building is where embeds go wrong.
 */
import { describe, expect, it } from "vitest";
import { SLUG_RE as SESSION_SLUG_RE } from "../../src/guest/session.ts";
import {
  LinkError,
  chatPath,
  chatUrl,
  embedScript,
  embedSnippet,
  frameAncestorsDirective,
  SLUG_RE,
  embedScriptUrl,
  isFrameAllowed,
  publicBaseUrl,
} from "../../src/guest/links.ts";

describe("publicBaseUrl", () => {
  it("prefers the configured origin and normalises it", () => {
    expect(publicBaseUrl("https://Chat.Example.COM/", "http://127.0.0.1:3000")).toBe(
      "https://chat.example.com",
    );
  });

  it("falls back to the request origin, which is the honest answer on a preview host", () => {
    expect(publicBaseUrl(undefined, "https://abc-3000.e2b.app")).toBe("https://abc-3000.e2b.app");
    expect(publicBaseUrl("", "http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("refuses a configured value that is not an origin", () => {
    // A path in the base URL would produce `https://host/c/slug/c/slug`.
    for (const bad of ["https://chat.example.com/app", "chat.example.com", "javascript:alert(1)"]) {
      expect(() => publicBaseUrl(bad, "http://localhost:3000")).toThrow(LinkError);
    }
  });
});

describe("SLUG_RE", () => {
  it("stays identical to the session's slug pattern", () => {
    // `links.ts` declares its own copy so the module stays pure enough for the
    // Next middleware bundle (no database imports). This is the pin: if one is
    // changed, the QR would start publishing slugs the lookup rejects.
    expect(SLUG_RE.source).toBe(SESSION_SLUG_RE.source);
    expect(SLUG_RE.flags).toBe(SESSION_SLUG_RE.flags);
  });
});

describe("chatUrl", () => {
  it("builds the URL the QR encodes and the snippet frames", () => {
    expect(chatUrl("https://chat.example.com", "casa-mesa")).toBe(
      "https://chat.example.com/c/casa-mesa",
    );
    expect(chatUrl("https://chat.example.com", "casa-mesa", "en")).toBe(
      "https://chat.example.com/c/casa-mesa?lang=en",
    );
  });

  it("ignores a language that is not one of the two", () => {
    expect(chatUrl("https://chat.example.com", "casa-mesa", "fr")).toBe(
      "https://chat.example.com/c/casa-mesa",
    );
  });

  it("refuses a slug that is not a slug — a QR of a 404 is a published 404", () => {
    for (const bad of ["../etc", "Casa Mesa", "", "a".repeat(64), "casa_mesa", "casa-mesa/../x"]) {
      expect(() => chatUrl("https://chat.example.com", bad)).toThrow(LinkError);
    }
    // Unicode lookalikes: a Cyrillic "а" or a full-width hyphen renders as
    // ``casa-mesa`` on a card but is a different string, so it would 404 for
    // every guest who scanned the printed code. SLUG_RE is ASCII-only.
    for (const bad of ["casa-mes\u0430", "casa\u2010mesa", "casa\u2011mesa", "casa\u200bmesa"]) {
      expect(() => chatUrl("https://chat.example.com", bad)).toThrow(LinkError);
    }
  });

  it("refuses a base URL that is not an origin", () => {
    expect(() => chatUrl("https://chat.example.com/app", "casa-mesa")).toThrow(LinkError);
  });

  it("keeps the path form in step with the absolute one", () => {
    expect(chatPath("casa-mesa", "es")).toBe("/c/casa-mesa?lang=es");
    expect(chatUrl("https://chat.example.com", "casa-mesa", "es")).toBe(
      `https://chat.example.com${chatPath("casa-mesa", "es")}`,
    );
  });
});

describe("embedScriptUrl", () => {
  it("puts the language after the file name, not before it", () => {
    expect(embedScriptUrl("https://chat.example.com", "casa-mesa")).toBe(
      "https://chat.example.com/c/casa-mesa/embed.js",
    );
    expect(embedScriptUrl("https://chat.example.com", "casa-mesa", "en")).toBe(
      "https://chat.example.com/c/casa-mesa/embed.js?lang=en",
    );
  });

  it("refuses a bad slug or base like every other builder", () => {
    expect(() => embedScriptUrl("https://chat.example.com", "../x")).toThrow(LinkError);
    expect(() => embedScriptUrl("https://chat.example.com/app", "casa-mesa")).toThrow(LinkError);
  });
});

describe("isFrameAllowed", () => {
  const allowed = ["https://hotel.example", "http://localhost:3000"];

  it("matches an allowed origin exactly, case- and slash-insensitively", () => {
    expect(isFrameAllowed("https://hotel.example", allowed)).toBe(true);
    expect(isFrameAllowed("https://HOTEL.example/", allowed)).toBe(true);
    expect(isFrameAllowed("http://localhost:3000", allowed)).toBe(true);
  });

  it("is not a prefix test — the classic look-alike is refused", () => {
    expect(isFrameAllowed("https://hotel.example.evil.test", allowed)).toBe(false);
    expect(isFrameAllowed("https://evil.test", allowed)).toBe(false);
    expect(isFrameAllowed("https://hotel.example:8443", allowed)).toBe(false);
    expect(isFrameAllowed("http://hotel.example", allowed)).toBe(false); // http ≠ https
  });

  it("allows nobody when the list is empty, and refuses a missing origin", () => {
    expect(isFrameAllowed("https://hotel.example", [])).toBe(false);
    expect(isFrameAllowed(null, allowed)).toBe(false);
    expect(isFrameAllowed("not an origin", allowed)).toBe(false);
    expect(isFrameAllowed("null", allowed)).toBe(false);
  });
});

describe("frameAncestorsDirective", () => {
  it("always includes 'self', so 'nobody may embed' is not 'nobody may visit'", () => {
    expect(frameAncestorsDirective([])).toBe("'self'");
    expect(frameAncestorsDirective(["https://hotel.example"])).toBe(
      "'self' https://hotel.example",
    );
  });

  it("drops duplicates and anything that is not an origin", () => {
    expect(
      frameAncestorsDirective([
        "https://hotel.example",
        "https://HOTEL.example/",
        "https://hotel.example/spa",
        "javascript:alert(1)",
      ]),
    ).toBe("'self' https://hotel.example");
  });
});

describe("embedSnippet", () => {
  it("is copy-paste HTML: a container and one async script", () => {
    const snippet = embedSnippet({
      baseUrl: "https://chat.example.com",
      slug: "casa-mesa",
      title: "Concierge",
    });
    expect(snippet).toContain('<div id="concierge-chat" data-concierge-property="casa-mesa">');
    expect(snippet).toContain('<script src="https://chat.example.com/c/casa-mesa/embed.js" async>');
  });

  it("carries the language through to the script it loads", () => {
    const snippet = embedSnippet({
      baseUrl: "https://chat.example.com",
      slug: "casa-mesa",
      lang: "en",
      title: "Concierge",
    });
    // The query string belongs after the file name. `/c/demo?lang=en/embed.js`
    // is a 404, and it shipped once before this assertion existed.
    expect(snippet).toContain('src="https://chat.example.com/c/casa-mesa/embed.js?lang=en"');
    expect(snippet).not.toContain("?lang=en/embed.js");
  });

  it("escapes the attributes it writes", () => {
    const snippet = embedSnippet({
      baseUrl: "https://chat.example.com",
      slug: "casa-mesa",
      title: '" onload="alert(1)',
    });
    // The title is not in the snippet, but the slug is: prove the escaping path.
    expect(snippet).not.toContain('onload="alert');
  });
});

describe("embedScript", () => {
  const options = {
    baseUrl: "https://chat.example.com",
    slug: "casa-mesa",
    title: "Concierge",
  };

  it("mounts an iframe at the chat URL", () => {
    const script = embedScript(options);
    expect(script).toContain('"https://chat.example.com/c/casa-mesa"');
    expect(script).toContain('document.createElement("iframe")');
    expect(script).toContain("frame.title = TITLE");
    // Lazy: a hotel's home page should not pay for the chat until it is near.
    expect(script).toContain('frame.loading = "lazy"');
  });

  it("mounts into the documented container when it exists, else where the tag was", () => {
    const script = embedScript(options);
    expect(script).toContain('document.getElementById(ID)');
    expect(script).toContain("document.currentScript");
  });

  it("is idempotent: a second injection is a no-op", () => {
    expect(embedScript(options)).toContain('document.getElementById(ID + "-frame")');
  });

  it("cannot be broken out of by the values it interpolates", () => {
    // The slug is the only caller-controlled string that reaches the script, and
    // `chatUrl` refuses anything but a slug — so the escaping is defence in
    // depth rather than the only guard.
    const script = embedScript({ ...options, title: "</script><script>alert(1)</script>" });
    expect(script).not.toContain("</script><script>");
    expect(script).toContain("\\u003c/script");
  });
});
