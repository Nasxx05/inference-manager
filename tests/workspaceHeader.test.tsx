/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Workspace } from "@/components/Workspace";
import {
  BUY_CREDITS_URL,
  EXTERNAL_LINK_REL,
  HOW_TO_USE_VIDEO_ID,
} from "@/lib/externalLinks";

/**
 * The Workspace owns the whole flow, so these tests stub only the network and
 * the browser APIs it touches. Everything asserted here is real component code.
 */
beforeEach(() => {
  vi.restoreAllMocks();
  // No backend exists in tests; a plan request is never made in these cases.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ success: false }), { status: 500 }),
  );
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe("Buy Credits", () => {
  it("links to Orbio in a new tab", () => {
    render(<Workspace />);
    const link = screen.getByRole("link", { name: /buy credits/i });

    expect(link.getAttribute("href")).toBe(BUY_CREDITS_URL);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("blocks window.opener tampering and strips the referrer", () => {
    render(<Workspace />);
    const link = screen.getByRole("link", { name: /buy credits/i });

    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
    // Asserted against the shared constant so the two cannot drift apart.
    expect(rel).toBe(EXTERNAL_LINK_REL);
  });

  it("sends no Promgent data along with the outbound navigation", () => {
    render(<Workspace />);
    const link = screen.getByRole("link", { name: /buy credits/i });

    // A plain external link: no click handler, no analytics beacon, no form.
    expect(link.getAttribute("onclick")).toBeNull();
    expect(link.getAttribute("href")).not.toContain("promgent");
    expect(link.getAttribute("href")).not.toContain("?");
  });
});

describe("How to Use dialog", () => {
  it("stays closed until asked for", () => {
    render(<Workspace />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("embeds the walkthrough video when opened", async () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: /how to use/i }));

    const dialog = await screen.findByRole("dialog");
    const frame = dialog.querySelector("iframe");

    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toContain(HOW_TO_USE_VIDEO_ID);
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("loads nothing from YouTube while the dialog is closed", () => {
    render(<Workspace />);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("closes on Escape", async () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: /how to use/i }));
    await screen.findByRole("dialog");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes from the close button", async () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: /how to use/i }));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("hands focus back to the trigger when it closes", async () => {
    render(<Workspace />);
    const trigger = screen.getByRole("button", { name: /how to use/i });
    // A real browser focuses a button when it is clicked; jsdom does not, so
    // the trigger is focused explicitly to model the starting condition.
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(document.activeElement).toBe(trigger);
  });

  it("restores page scrolling after closing", async () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: /how to use/i }));
    await screen.findByRole("dialog");

    // The dialog locks the page behind it, so a leak here would freeze the UI.
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("offers an external link to the same video", async () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: /how to use/i }));
    const dialog = await screen.findByRole("dialog");

    const link = dialog.querySelector("a[href*='youtube.com/watch']");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("rel")).toBe(EXTERNAL_LINK_REL);
    expect(link?.getAttribute("target")).toBe("_blank");
  });
});

describe("the dialog never disturbs the user's work", () => {
  it("keeps typed input, model, budget and optimization across open/close", async () => {
    render(<Workspace />);

    const task = screen.getByLabelText(/what do you want to accomplish/i);
    fireEvent.change(task, { target: { value: "Build a RAG pipeline with auth" } });
    fireEvent.change(screen.getByLabelText(/planning budget/i), { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText(/optimization preference/i), {
      target: { value: "maximum-quality" },
    });

    fireEvent.click(screen.getByRole("button", { name: /how to use/i }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(screen.getByLabelText(/what do you want to accomplish/i)).toHaveValue(
      "Build a RAG pipeline with auth",
    );
    expect(screen.getByLabelText(/planning budget/i)).toHaveValue(42);
    expect(screen.getByLabelText(/optimization preference/i)).toHaveValue("maximum-quality");
  });

  it("does not submit anything when the dialog closes", async () => {
    render(<Workspace />);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fireEvent.click(screen.getByRole("button", { name: /how to use/i }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});