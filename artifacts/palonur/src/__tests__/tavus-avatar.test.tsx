import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const daily = vi.hoisted(() => {
  const call = {
    on: vi.fn(),
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    participants: vi.fn(() => ({ local: { session_id: "local" } })),
    startTranscription: vi.fn(),
    setLocalAudio: vi.fn(async () => undefined),
  };
  return { call };
});

vi.mock("@daily-co/daily-js", () => ({
  default: {
    createCallObject: vi.fn(() => daily.call),
  },
}));

import TavusAvatarButton from "../components/TavusAvatar.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("faculty avatar voice handoff", () => {
  test("joins directly with the existing visitor name, mic enabled, and camera off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            conversation_id: "conversation-1",
            conversation_url: "https://tavus.daily.co/conversation-1?skipPreJoinUi=1",
          }),
          { status: 200 },
        ),
      ),
    );

    render(
      <TavusAvatarButton
        persona="steward"
        steward={{
          pillarSlug: "sleep",
          pillarName: "Sleep",
          stewardName: "Jamie Zeitzer",
          institution: "Stanford Lifestyle Medicine",
        }}
        visitorName="Pat"
        triggerVariant="inline"
        triggerLabel="Start voice conversation"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start voice conversation" }));

    await waitFor(() =>
      expect(daily.call.join).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://tavus.daily.co/conversation-1",
          userName: "Pat",
          startVideoOff: true,
          startAudioOff: false,
        }),
      ),
    );
  });
});