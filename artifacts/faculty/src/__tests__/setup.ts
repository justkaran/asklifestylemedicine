import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount React trees between tests so shared module-level state (e.g. the
// app's QueryClient cache) can't leak rendered nodes across cases.
afterEach(() => {
  cleanup();
});
