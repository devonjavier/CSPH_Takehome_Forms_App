import type { DraftQuestion } from "../../../api/src/contracts/draft";

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
    case "multi_select":
    case "checkboxes": {
      const selected = Array.isArray(value) ? value : [];
      // Checkboxes give both multiple-selection types usable phone controls
      // without requiring Ctrl/Command clicks in a native multi-select list.
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
