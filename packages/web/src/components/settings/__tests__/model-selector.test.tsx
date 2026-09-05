import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ModelSelector } from "../model-selector"
import { CUSTOM_MODEL_VALUE } from "@/lib/model-catalog"

describe("ModelSelector", () => {
  it("shows models for the selected vendor and emits a curated model id", () => {
    const onChange = vi.fn()
    render(
      <ModelSelector
        id="model"
        engine="claude"
        model="claude-opus-5"
        onChange={onChange}
      />,
    )

    expect(screen.getByRole("option", { name: /Opus 5/ })).toBeDefined()
    expect(screen.queryByRole("option", { name: /GPT-5\.6 Sol/ })).toBeNull()

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "sonnet" } })
    expect(onChange).toHaveBeenCalledWith("sonnet")
  })

  it("reveals a manual input when custom is selected", () => {
    const onChange = vi.fn()
    render(
      <ModelSelector
        id="model"
        engine="codex"
        model="gpt-5.6-sol"
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: CUSTOM_MODEL_VALUE },
    })
    const input = screen.getByRole("textbox", { name: "カスタムモデルID" })
    fireEvent.change(input, { target: { value: "gpt-private-preview" } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith("gpt-private-preview")
  })

  it("does not close custom input when a typing prefix matches a catalog id", () => {
    const onChange = vi.fn()
    render(
      <ModelSelector
        id="model"
        engine="gemini"
        model="gemini-2.5-pro"
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: CUSTOM_MODEL_VALUE },
    })
    const input = screen.getByRole("textbox", { name: "カスタムモデルID" })
    fireEvent.change(input, { target: { value: "flash" } })
    expect(screen.getByRole("textbox", { name: "カスタムモデルID" })).toBeDefined()
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: "flash-private-preview" } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith("flash-private-preview")
  })

  it("keeps the existing custom value when the draft is left empty", () => {
    const onChange = vi.fn()
    render(
      <ModelSelector
        id="model"
        engine="codex"
        model="gpt-private-preview"
        onChange={onChange}
      />,
    )

    const input = screen.getByRole("textbox", { name: "カスタムモデルID" })
    fireEvent.change(input, { target: { value: "" } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "gpt-private-preview",
    )
  })

  it("cancels a custom draft with Escape without committing on blur", () => {
    const onChange = vi.fn()
    render(
      <ModelSelector
        id="model"
        engine="codex"
        model="gpt-5.6-sol"
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: CUSTOM_MODEL_VALUE },
    })
    const input = screen.getByRole("textbox", { name: "カスタムモデルID" })
    fireEvent.change(input, { target: { value: "gpt-discard-me" } })
    fireEvent.keyDown(input, { key: "Escape" })

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole("textbox", { name: "カスタムモデルID" })).toBeNull()
  })

  it("preserves an unknown configured id in custom mode", () => {
    render(
      <ModelSelector
        id="model"
        engine="codex"
        model="gpt-legacy-custom"
        onChange={vi.fn()}
        allowAutomatic
      />,
    )

    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      CUSTOM_MODEL_VALUE,
    )
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "gpt-legacy-custom",
    )
  })

  it("offers an automatic option for triage", () => {
    const onChange = vi.fn()
    render(
      <ModelSelector
        id="model"
        engine="codex"
        model="gpt-5-nano"
        onChange={onChange}
        allowAutomatic
      />,
    )

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } })
    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})
