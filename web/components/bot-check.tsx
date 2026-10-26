"use client";

import * as React from "react";

/**
 * S07-04 AC-1 — the bot check's browser half.
 *
 * The server verifies a Turnstile token on the conversation's first message
 * (`src/security/botcheck.ts`). This component is where that token comes from.
 * Three decisions worth stating:
 *
 *  - **No site key ⇒ no widget, and no token.** That is the local/preview case,
 *    where the server's bot check is `disabled` by configuration. Rendering a
 *    broken challenge on a host that does not enforce one would be worse than
 *    rendering nothing.
 *  - **The script is loaded once, explicitly.** Cloudflare's `render=explicit`
 *    mode is used because implicit mode scans the DOM on load and re-renders on
 *    navigation; an explicit `render()` into a ref is a component, not a
 *    document-level side effect.
 *  - **Tokens are single use.** The parent resets the widget after a send
 *    (`resetKey`), because the second message would otherwise carry a spent
 *    token. The server only checks the first message, so the practical effect is
 *    that a retry of the first message still works.
 */

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The subset of the Turnstile global this component touches. */
interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "auto" | "light" | "dark";
      size?: "normal" | "compact" | "flexible";
    },
  ) => string | undefined;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

/** One script load per page, however many widgets are mounted. */
function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile !== undefined) return Promise.resolve();
  if (scriptPromise !== null) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("turnstile script failed to load")));
    if (existing === null) {
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
  return scriptPromise;
}

export interface BotCheckProps {
  siteKey: string | undefined;
  /** Called with the token, then with null when the widget is reset. */
  onToken: (token: string | null) => void;
  /** Bump this to reset the widget (a spent token cannot be reused). */
  resetKey: number;
}

export function BotCheck({ siteKey, onToken, resetKey }: BotCheckProps): React.ReactElement | null {
  const container = React.useRef<HTMLDivElement | null>(null);
  const widgetId = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    if (siteKey === undefined || siteKey === "" || container.current === null) return;
    let cancelled = false;
    void loadScript()
      .then(() => {
        const api = window.turnstile;
        if (cancelled || api === undefined || container.current === null) return;
        widgetId.current = api.render(container.current, {
          sitekey: siteKey,
          callback: (token: string) => onToken(token),
          // An expired token is not an error the guest caused, so it goes back
          // to "no token yet" rather than showing a failure.
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
          theme: "auto",
          size: "flexible",
        });
      })
      .catch(() => {
        // A blocked script means no token, so the server's enforced check will
        // refuse the first message — which is the honest outcome for a browser
        // that did not run the challenge.
        onToken(null);
      });
    return () => {
      cancelled = true;
    };
    // `onToken` is deliberately not a dependency: the parent passes a stable
    // setter, and re-rendering the widget on every keystroke would fight the
    // Turnstile iframe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  React.useEffect(() => {
    if (resetKey === 0 || widgetId.current === undefined) return;
    window.turnstile?.reset(widgetId.current);
    onToken(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  if (siteKey === undefined || siteKey === "") return null;
  return <div ref={container} className="min-h-[65px]" aria-hidden="false" />;
}
