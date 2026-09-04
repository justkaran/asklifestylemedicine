import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ExcludeSourceAction } from "../App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

describe("ExcludeSourceAction", () => {
  it("renders exclude button and opens popover on click", () => {
    const qc = new QueryClient();
    const source = { id: 123, automaticallyDiscovered: true } as any;
    
    render(
      <QueryClientProvider client={qc}>
        <ExcludeSourceAction source={source} slug="test-pillar" />
      </QueryClientProvider>
    );

    const btn = screen.getByTestId("button-exclude-123");
    expect(btn).not.toBeNull();
    
    fireEvent.click(btn);
    
    expect(screen.getByText("Exclude from pillar")).not.toBeNull();
    expect(screen.getByTestId("input-exclude-reason-123")).not.toBeNull();
    expect(screen.getByTestId("button-confirm-exclude-123")).not.toBeNull();
  });
});
