import { describe, it, expect } from "vitest";
import { encodeWatermark, extractWatermark, extractPalonurWatermark, stripWatermark, watermarkText } from "@/lib/watermark";

describe("invisible watermark", () => {
  it("round-trips a payload", () => {
    const marked = watermarkText("Sleep is the foundation of health.", "palonur:/slm");
    expect(extractWatermark(marked)).toBe("palonur:/slm");
  });

  it("is invisible: stripping zero-width chars restores the original", () => {
    const original = "Sleep is the foundation of health.";
    const marked = watermarkText(original, "palonur:/");
    expect(marked).not.toBe(original);
    expect(stripWatermark(marked)).toBe(original);
  });

  it("survives being embedded mid-document", () => {
    const doc = "Intro.\n\n" + watermarkText("Copied Palonur paragraph here.", "palonur:/sleep") + "\n\nOutro.";
    expect(extractWatermark(doc)).toBe("palonur:/sleep");
  });

  it("returns null on clean text and garbage runs", () => {
    expect(extractWatermark("No signature here.")).toBeNull();
    expect(extractWatermark("odd \u200B\u200C\u200D\u200C\u200B run")).toBeNull(); // not a multiple of 8 bits
    expect(extractWatermark(encodeWatermark(""))).toBeNull();
  });

  it("a malformed earlier run does not mask a later valid mark", () => {
    const doc = "x\u200B\u200C\u200D\u200C\u200Bx " + watermarkText("Real Palonur text follows.", "palonur:/slm");
    expect(extractWatermark(doc)).toBe("palonur:/slm");
  });

  it("rejects oversized runs before decoding", () => {
    const huge = "\u200B" + "\u200C".repeat(4096) + "\u200B";
    expect(extractWatermark(huge)).toBeNull();
  });

  it("palonur checker only accepts palonur: payloads", () => {
    expect(extractPalonurWatermark(watermarkText("some text", "forged:mark"))).toBeNull();
    expect(extractPalonurWatermark(watermarkText("some text", "palonur:/"))).toBe("palonur:/");
  });
});
