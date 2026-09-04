import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Initialize i18n so useTranslation() resolves real locale strings (including
// returnObjects arrays) rather than returning raw keys in every test.
import "../i18n";

// Unmount React trees between tests so module-level state can't leak rendered
// nodes across cases.
afterEach(() => {
  cleanup();
});
