/** @vitest-environment jsdom */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectComposer } from "@/components/project/ProjectComposer";

describe("conversation composer", () => {
  it("keeps the transcript editable and sends on Enter", () => {
    const onChange = vi.fn(); const onSubmit = vi.fn();
    render(<ProjectComposer value="Editable transcript" onChange={onChange} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/Ask Promgent anything/i);
    fireEvent.change(input, { target: { value: "Edited transcript" } });
    expect(onChange).toHaveBeenCalledWith("Edited transcript", "text");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("shows an attached image and allows removing it", () => {
    const onImageChange = vi.fn();
    const image = new File(["image"], "reference.png", { type: "image/png" });
    render(<ProjectComposer value="Use this reference" onChange={vi.fn()} onSubmit={vi.fn()} image={image} onImageChange={onImageChange} />);
    expect(screen.getByText(/reference\.png/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /remove image/i }));
    expect(onImageChange).toHaveBeenCalledWith(null);
  });
});
