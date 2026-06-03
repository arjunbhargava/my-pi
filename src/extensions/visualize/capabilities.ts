/**
 * Terminal image-capability reconciliation.
 *
 * pi-tui's `detectCapabilities()` identifies graphics-capable terminals from
 * `TERM_PROGRAM` / `ITERM_SESSION_ID` / `KITTY_WINDOW_ID` and similar variables.
 * None of those survive an SSH hop by default, so a remote pi session inside a
 * graphics-capable terminal is misdetected as `images: null` and the visualize
 * tool silently renders a text placeholder instead of pixels.
 *
 * `LC_TERMINAL` is set by iTerm2 and WezTerm and *is* forwarded over SSH (it
 * matches the default `SendEnv LC_*` / `AcceptEnv LC_*` rules). This module uses
 * it as a fallback signal to restore image support when, and only when, the
 * primary detection found none.
 */

import { getCapabilities, type ImageProtocol, setCapabilities } from "@earendil-works/pi-tui";

/**
 * Maps a known `LC_TERMINAL` value to the image protocol that terminal speaks.
 *
 * Only terminals that set `LC_TERMINAL` and are confirmed graphics-capable are
 * listed. WezTerm implements the Kitty graphics protocol, matching pi-tui's own
 * detection mapping.
 *
 * @param lcTerminal - Raw `LC_TERMINAL` value (case-insensitive).
 * @returns The image protocol, or null if the value is unknown/unset.
 */
export function imageProtocolFromLcTerminal(lcTerminal: string | undefined): ImageProtocol {
  switch ((lcTerminal ?? "").toLowerCase()) {
    case "iterm2":
      return "iterm2";
    case "wezterm":
      return "kitty";
    default:
      return null;
  }
}

/**
 * Restores image support when primary detection missed it but `LC_TERMINAL`
 * positively identifies a graphics-capable terminal (typically an SSH session).
 *
 * Conservative by design: it never downgrades or overrides an already-detected
 * protocol, and only acts on an allowlist of known `LC_TERMINAL` values. If the
 * terminal genuinely lacks image support, nothing changes.
 *
 * @param env - Environment to read `LC_TERMINAL` from. Defaults to `process.env`.
 * @returns The protocol that was applied, or null if capabilities were left unchanged.
 */
export function reconcileImageCapabilities(env: NodeJS.ProcessEnv = process.env): ImageProtocol {
  const current = getCapabilities();
  if (current.images !== null) return null;

  const protocol = imageProtocolFromLcTerminal(env.LC_TERMINAL);
  if (protocol === null) return null;

  setCapabilities({ ...current, images: protocol, trueColor: true });
  return protocol;
}
