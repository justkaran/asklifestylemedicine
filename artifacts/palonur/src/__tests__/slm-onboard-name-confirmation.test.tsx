import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OnboardCard } from "../pages/slm-chat.js";

afterEach(cleanup);

describe("standalone welcome name registration handoff", () => {
  test("uses the existing browser-only name and asks only for email", () => {
    render(<OnboardCard initialName="Morgan" onRegistered={() => {}} />);

    expect(screen.getByText(/where should we reach you/i)).toBeTruthy();
    expect(screen.queryByLabelText("Your first name")).toBeNull();
    expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy();
  });

  test("still asks a brand-new visitor for their first name", () => {
    render(<OnboardCard onRegistered={() => {}} />);

    expect(screen.getByText(/what is your first name/i)).toBeTruthy();
    const name = screen.getByLabelText("Your first name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Taylor" } });
    fireEvent.submit(name.closest("form")!);

    expect(screen.getByText(/where should we reach you/i)).toBeTruthy();
  });
});