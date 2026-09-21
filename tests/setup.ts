/**
 * Runs for every test file. Node-environment tests import nothing from here
 * that touches the DOM, so the guards keep them working unchanged.
 */
import { afterEach } from "vitest";

// Only meaningful when jsdom is active; Node tests have no global document.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  const { cleanup } = await import("@testing-library/react");

  afterEach(() => {
    cleanup();
    document.body.style.overflow = "";
  });
}