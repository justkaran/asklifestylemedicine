import { describe, expect, test } from "vitest";
import { cleanFirstName, warmReturnGreeting } from "../lib/return-greeting";

// Roll pinned per test so variant selection is deterministic.

describe("cleanFirstName", () => {
  test("takes the first token of a full name", () => {
    expect(cleanFirstName("Karan Singh")).toBe("Karan");
  });
  test("rejects empty / whitespace / null / undefined inputs", () => {
    expect(cleanFirstName("")).toBeNull();
    expect(cleanFirstName("   ")).toBeNull();
    expect(cleanFirstName(null)).toBeNull();
    expect(cleanFirstName(undefined)).toBeNull();
  });
  test("rejects the literal strings 'null' and 'undefined'", () => {
    expect(cleanFirstName("null")).toBeNull();
    expect(cleanFirstName("Undefined")).toBeNull();
  });
  test("rejects implausibly long names", () => {
    expect(cleanFirstName("x".repeat(41))).toBeNull();
  });
});

describe("warmReturnGreeting", () => {
  test("greets by name when a name is known", () => {
    expect(warmReturnGreeting("Karan", "en", 0)).toBe(
      "The day just got better. Karan is here.",
    );
  });
  test("uses only the first name from a full name", () => {
    const g = warmReturnGreeting("Karan Singh", "en", 0);
    expect(g).toContain("Karan");
    expect(g).not.toContain("Singh");
  });
  test("falls back to a friendly name-free variant without a name", () => {
    expect(warmReturnGreeting(null, "en", 0)).toBe(
      "The day just got better. Welcome back.",
    );
    expect(warmReturnGreeting(undefined, "en", 1)).toBe(
      "Welcome back. It is good to see you again.",
    );
  });
  test("never interpolates 'null'/'undefined'/empty into the copy", () => {
    for (const bad of [
      "",
      "  ",
      "null",
      "undefined",
      null,
      undefined,
    ] as const) {
      for (let roll = 0; roll < 3; roll++) {
        const g = warmReturnGreeting(bad, "en", roll);
        expect(g.length).toBeGreaterThan(0);
        expect(g).not.toMatch(/null|undefined/i);
        expect(g).not.toMatch(/\s{2,}|,\s*\./);
      }
    }
  });
  test("localizes to German and falls back to English otherwise", () => {
    expect(warmReturnGreeting("Karan", "de", 0)).toBe(
      "Der Tag ist gerade besser geworden. Karan ist wieder da.",
    );
    expect(warmReturnGreeting(null, "de-DE", 0)).toBe(
      "Der Tag ist gerade besser geworden. Willkommen zurück.",
    );
    expect(warmReturnGreeting("Karan", "fr", 0)).toContain("Karan is here.");
  });
});
