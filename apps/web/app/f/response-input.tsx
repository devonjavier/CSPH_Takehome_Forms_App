import type { DraftQuestion } from "../../../api/src/contracts/draft";
import { useEffect, useRef } from "react";

export function ResponseInput({
  question,
  value,
  error,
  onChange,
}: {
  question: DraftQuestion;
  value: string | string[];
  error: string;
  onChange: (value: string | string[]) => void;
}) {
  const dropdown = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (question.type !== "multi_select") return;
    const dismissOutside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !dropdown.current?.contains(event.target) &&
        dropdown.current
      )
        dropdown.current.open = false;
    };
    // Pointer events distinguish an option-label click from leaving the control;
    // closing on blur alone can hide a label before it toggles its checkbox.
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [question.type]);
  const text = typeof value === "string" ? value : "";
  const common = {
    id: `answer-${question.id}`,
    "aria-label": question.label,
    "aria-required": question.required,
    "aria-invalid": Boolean(error),
    "aria-describedby": error ? `error-${question.id}` : undefined,
  };
  switch (question.type) {
    case "short_text":
      return (
        <input
          {...common}
          type="text"
          maxLength={1000}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "long_text":
      return (
        <textarea
          {...common}
          maxLength={10000}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "date":
      return (
        <input
          {...common}
          type="date"
          min="0001-01-01"
          max="9999-12-31"
          value={text}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
      );
    case "linear_scale":
      return (
        <>
          <p className="hint">
            {question.min}: {question.minLabel || "Minimum"} — {question.max}:{" "}
            {question.maxLabel || "Maximum"}
          </p>
          <input
            {...common}
            type="number"
            step={1}
            min={question.min ?? undefined}
            max={question.max ?? undefined}
            value={text}
            onInput={(event) => onChange(event.currentTarget.value)}
          />
        </>
      );
    case "dropdown":
      return (
        <select
          {...common}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose an option</option>
          {question.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case "multiple_choice":
      return (
        <>
          {question.options.map((option) => (
            <label className="checkbox-label" key={option.id}>
              <input
                type="radio"
                name={question.id}
                value={option.id}
                checked={text === option.id}
                onChange={() => onChange(option.id)}
                aria-invalid={Boolean(error)}
                aria-describedby={common["aria-describedby"]}
              />
              {option.label}
            </label>
          ))}
          {!question.required && (
            <button type="button" onClick={() => onChange("")}>
              Clear selection
            </button>
          )}
        </>
      );
    case "multi_select": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <details
          ref={dropdown}
          className="multi-select"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            {...common}
            aria-label={`${question.label}: ${selected.length} selected`}
          >
            {selected.length ? `${selected.length} selected` : "Choose options"}
          </summary>
          <div className="multi-select-options">
            <p className="hint">
              Select all that apply. Escape closes this dropdown.
            </p>
            {question.options.map((option) => (
              <label className="checkbox-label" key={option.id}>
                <input
                  type="checkbox"
                  value={option.id}
                  checked={selected.includes(option.id)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, option.id]
                        : selected.filter((id) => id !== option.id),
                    )
                  }
                  aria-describedby={common["aria-describedby"]}
                />
                {option.label}
              </label>
            ))}
            <button
              type="button"
              disabled={!selected.length}
              onClick={() => onChange([])}
            >
              Clear selections
            </button>
          </div>
        </details>
      );
    }
    case "checkboxes": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <>
          <p className="hint">Select all that apply.</p>
          {question.options.map((option) => (
            <label className="checkbox-label" key={option.id}>
              <input
                type="checkbox"
                value={option.id}
                checked={selected.includes(option.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.id]
                      : selected.filter((id) => id !== option.id),
                  )
                }
                aria-invalid={Boolean(error)}
                aria-describedby={common["aria-describedby"]}
              />
              {option.label}
            </label>
          ))}
        </>
      );
    }
  }
}
