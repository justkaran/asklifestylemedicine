import { describe, it, expect } from "vitest";
import { journeyInviteTopic } from "../lib/journey-invite-topic";
import enCommon from "../locales/en/common.json";
import deCommon from "../locales/de/common.json";

describe("journeyInviteTopic — 7-nights invite matches the question topic", () => {
  it("matches German night-waking questions (the 3am case)", () => {
    expect(journeyInviteTopic("Warum wache ich jede Nacht um 3 Uhr auf?")).toBe("wake3am");
    expect(journeyInviteTopic("Ich wache mitten in der Nacht auf und kann nicht mehr schlafen")).toBe("wake3am");
  });

  it("matches English night-waking questions", () => {
    expect(journeyInviteTopic("Why do I wake up at 3am every night?")).toBe("wake3am");
    expect(journeyInviteTopic("I keep waking in the middle of the night")).toBe("wake3am");
  });

  it("matches falling-asleep questions in both languages", () => {
    expect(journeyInviteTopic("Warum kann ich abends nicht einschlafen?")).toBe("fallAsleep");
    expect(journeyInviteTopic("I can't fall asleep because of racing thoughts")).toBe("fallAsleep");
  });

  it("prefers the specific substance topic over broad sleep patterns", () => {
    expect(journeyInviteTopic("Does coffee in the afternoon keep me from falling asleep?")).toBe("caffeine");
    expect(journeyInviteTopic("Ist Kaffee am Nachmittag schlecht für den Schlaf?")).toBe("caffeine");
    expect(journeyInviteTopic("Hilft ein Glas Wein beim Einschlafen?")).toBe("alcohol");
  });

  it("matches dreams, early waking, screens and daytime tiredness", () => {
    expect(journeyInviteTopic("Warum habe ich so intensive Träume?")).toBe("dreams");
    expect(journeyInviteTopic("I wake up too early and can't get back to sleep")).toBe("earlyWake");
    expect(journeyInviteTopic("Ist das Handy im Bett wirklich so schlimm?")).toBe("screens");
    expect(journeyInviteTopic("Warum bin ich tagsüber immer so müde?")).toBe("daytime");
  });

  it("returns null for questions with no recognizable topic (generic fallback)", () => {
    expect(journeyInviteTopic("Was ist die beste Schlafposition?")).toBeNull();
    expect(journeyInviteTopic("")).toBeNull();
  });

  it("every topic key has a heading in both locale files", () => {
    const topics = ["caffeine", "alcohol", "screens", "dreams", "wake3am", "earlyWake", "fallAsleep", "daytime"] as const;
    const en = (enCommon as any).sleepAgent.answer.journey.inviteHeadingTopics;
    const de = (deCommon as any).sleepAgent.answer.journey.inviteHeadingTopics;
    for (const topic of topics) {
      expect(en[topic], `en heading for ${topic}`).toContain("7 nights");
      expect(de[topic], `de heading for ${topic}`).toContain("7 Nächte");
    }
  });
});
