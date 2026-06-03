import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetCapabilitiesCache, setCapabilities, getCapabilities } from "@earendil-works/pi-tui";
import { imageProtocolFromLcTerminal, reconcileImageCapabilities } from "./capabilities.js";

describe("imageProtocolFromLcTerminal", () => {
  it("maps iTerm2 to the iterm2 protocol (case-insensitive)", () => {
    assert.equal(imageProtocolFromLcTerminal("iTerm2"), "iterm2");
    assert.equal(imageProtocolFromLcTerminal("ITERM2"), "iterm2");
  });

  it("maps WezTerm to the kitty protocol", () => {
    assert.equal(imageProtocolFromLcTerminal("WezTerm"), "kitty");
  });

  it("returns null for unknown or unset values", () => {
    assert.equal(imageProtocolFromLcTerminal(undefined), null);
    assert.equal(imageProtocolFromLcTerminal(""), null);
    assert.equal(imageProtocolFromLcTerminal("xterm"), null);
  });
});

describe("reconcileImageCapabilities", () => {
  beforeEach(() => {
    // Force a known starting point: no image support detected.
    resetCapabilitiesCache();
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  });

  it("restores iterm2 support from LC_TERMINAL when none was detected", () => {
    const applied = reconcileImageCapabilities({ LC_TERMINAL: "iTerm2" });
    assert.equal(applied, "iterm2");
    assert.equal(getCapabilities().images, "iterm2");
    assert.equal(getCapabilities().trueColor, true);
  });

  it("restores kitty support for WezTerm", () => {
    const applied = reconcileImageCapabilities({ LC_TERMINAL: "WezTerm" });
    assert.equal(applied, "kitty");
    assert.equal(getCapabilities().images, "kitty");
  });

  it("leaves capabilities unchanged when LC_TERMINAL is unknown", () => {
    const applied = reconcileImageCapabilities({ LC_TERMINAL: "xterm" });
    assert.equal(applied, null);
    assert.equal(getCapabilities().images, null);
  });

  it("does not override an already-detected protocol", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const applied = reconcileImageCapabilities({ LC_TERMINAL: "iTerm2" });
    assert.equal(applied, null);
    assert.equal(getCapabilities().images, "kitty");
  });
});
