import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";

const LOCALES_DIR = path.resolve(import.meta.dirname, "../locales");
const EN_DIR = path.join(LOCALES_DIR, "en");
const DE_DIR = path.join(LOCALES_DIR, "de");

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function flatKeys(obj: JsonValue, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [prefix];
  }
  return Object.entries(obj).flatMap(([k, v]) => {
    const full = prefix ? `${prefix}.${k}` : k;
    return flatKeys(v, full);
  });
}

const namespaces = readdirSync(EN_DIR).filter((f) => f.endsWith(".json"));

describe("DE locale completeness", () => {
  for (const filename of namespaces) {
    it(`de/${filename} covers every key in en/${filename}`, () => {
      const enRaw = readFileSync(path.join(EN_DIR, filename), "utf8");
      const deRaw = readFileSync(path.join(DE_DIR, filename), "utf8");

      const enObj = JSON.parse(enRaw) as JsonValue;
      const deObj = JSON.parse(deRaw) as JsonValue;

      const enKeys = new Set(flatKeys(enObj));
      const deKeys = new Set(flatKeys(deObj));

      const missing = [...enKeys].filter((k) => !deKeys.has(k));

      expect(
        missing,
        missing.length > 0
          ? `de/${filename} is missing ${missing.length} key(s):\n${missing.map((k) => `  - ${k}`).join("\n")}`
          : "",
      ).toEqual([]);
    });
  }
});
