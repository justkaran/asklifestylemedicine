import { describe, expect, test } from "vitest";
import {
  AUTO_PLATFORM_ADMIN_EMAILS,
  AUTO_PILLAR_DEFINITIONS,
  AUTO_RETIRE_PILLARS,
  AUTO_STEWARD_MEMBERSHIPS,
} from "../middlewares/facultyAuth.js";
import { isBillingEnabled } from "../lib/features.js";
import { ASLM_DIRECTOR_EMAILS } from "../routes/faculty.js";

describe("Karan Dehghani bootstrap configuration", () => {
  test("has exactly one platform-admin identity", () => {
    expect([...AUTO_PLATFORM_ADMIN_EMAILS]).toEqual([
      "kdegani@stanford.edu",
    ]);
  });
  test("recognizes the Stanford account as an ASLM director", () => {
    expect(ASLM_DIRECTOR_EMAILS.has("kdegani@stanford.edu")).toBe(true);
  });

  test("provisions only the combined AI Lab stewardship", () => {
    expect(AUTO_STEWARD_MEMBERSHIPS["kdegani@stanford.edu"]).toEqual([
      { pillarSlug: "slm-ai-lab", role: "steward" },
    ]);
    expect(AUTO_PILLAR_DEFINITIONS["slm-ai-lab"]).toEqual({
      name: "AI Lab for Education and Leadership",
      description:
        "Artificial intelligence for education, scientific literacy, institutional leadership, and accountable decision-making.",
    });
    expect(AUTO_PILLAR_DEFINITIONS["ai-leadership"]).toBeUndefined();
    expect(AUTO_PILLAR_DEFINITIONS["ai-education"]).toBeUndefined();
    expect(AUTO_RETIRE_PILLARS["kdegani@stanford.edu"]).toEqual([
      "ai-leadership",
      "ai-education",
    ]);
  });
});

describe("billing feature flag", () => {
  test.each([
    [false, undefined],
    [false, ""],
    [false, "false"],
    [false, "1"],
    [true, "true"],
    [true, " TRUE "],
  ])("returns %s when BILLING_ENABLED is %s", (expected, value) => {
    expect(isBillingEnabled({ BILLING_ENABLED: value })).toBe(expected);
  });

  test("stays disabled in Stanford edition even if billing is set true", () => {
    expect(
      isBillingEnabled({
        BILLING_ENABLED: "true",
        STANFORD_EDITION: "true",
      }),
    ).toBe(false);
  });
});
