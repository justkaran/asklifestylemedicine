import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Route } from "wouter";
import WhatIsPalonur from "../pages/what-is-palonur";
import AiWithoutTraining from "../pages/ai-without-training";

describe("governed knowledge public pages", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
  });

  test("renders the What is Palonur explainer with its inference-only policy", () => {
    window.history.replaceState({}, "", "/what-is-palonur");
    render(<Route path="/what-is-palonur" component={WhatIsPalonur} />);

    expect(screen.getByTestId("heading-what-is-palonur").textContent).toMatch(
      /governed knowledge layer/i,
    );
    expect(
      screen.getByTestId("text-what-is-inference-only-policy").textContent,
    ).toMatch(/inference only/i);
    expect(screen.getByTestId("link-agent-license").getAttribute("href")).toBe(
      "/agent-license",
    );
  });

  test("renders the AI-without-training problem and policy boundary", () => {
    window.history.replaceState({}, "", "/ai-without-training");
    render(<Route path="/ai-without-training" component={AiWithoutTraining} />);

    expect(screen.getByTestId("heading-ai-without-training").textContent).toMatch(
      /AI needs trusted knowledge/i,
    );
    expect(screen.getByTestId("text-inference-only-policy").textContent).toMatch(
      /contractual no-training policy/i,
    );
    expect(screen.getByTestId("text-inference-only-policy").textContent).toMatch(
      /not a claim that Palonur can technically prevent every downstream use/i,
    );
  });
});