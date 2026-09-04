export const LANDING_SEARCH_STAGES = [
  { id: "stanford", label: "Stanford" },
  { id: "chicago", label: "University of Chicago" },
  { id: "harvard", label: "Harvard" },
  { id: "oxford", label: "Oxford" },
  { id: "cambridge", label: "Cambridge" },
  { id: "other-ivies", label: "Other Ivy League universities" },
] as const;

export type LandingAuthority = {
  id: string;
  name: string;
  institution: string;
  field: string;
  expertise: string;
  sourceLabel: string;
  sourceUrl: string;
};

export type LandingAuthorityDemo = {
  question: string;
  topic: string;
  response: string;
  whyThisSteward: string;
  designationClaim: string;
  stages: typeof LANDING_SEARCH_STAGES;
  authority: LandingAuthority | null;
};

export type LandingFollowUp = {
  question: string;
  answer: string;
};

const BASE = import.meta.env.BASE_URL;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE}api/landing-demo/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null;
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? payload.error
        : undefined;
    throw new Error(error || "The demo could not complete this request.");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("The demo returned an invalid response.");
  }
  return payload as T;
}

export function fetchLandingAuthority(
  question: string,
): Promise<LandingAuthorityDemo> {
  return postJson<LandingAuthorityDemo>("route", { question });
}

export function fetchLandingFollowUp(input: {
  originalQuestion: string;
  authorityId: string;
  topic: string;
  question: string;
}): Promise<LandingFollowUp> {
  return postJson<LandingFollowUp>("follow-up", input);
}