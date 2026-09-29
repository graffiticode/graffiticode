// SPDX-License-Identifier: MIT
// Renders a single L0174 field by type. Preflight is off (this is a published component),
// so inputs carry explicit styling.
import type { FieldDef } from "./validate";

function classNames(...classes: any[]) {
  return classes.filter(Boolean).join(" ");
}

export function Field({
  field,
  value,
  error,
  theme,
  onChange,
}: {
  field: FieldDef;
  value: any;
  error?: string;
  theme: string | undefined;
  onChange: (name: string, value: any) => void;
}) {
  const dark = theme === "dark";
  const inputBase = classNames(
    "appearance-none w-full rounded-md border px-3 py-2 text-sm outline-none transition",
    dark
      ? "bg-zinc-800 border-zinc-700 text-white placeholder-zinc-500 focus:border-zinc-500"
      : "bg-white border-zinc-300 text-zinc-900 placeholder-zinc-400 focus:border-zinc-500",
    error && "border-red-500",
  );
  const labelCls = classNames("text-sm font-medium", dark ? "text-zinc-200" : "text-zinc-700");
  const helpCls = classNames("text-xs", dark ? "text-zinc-400" : "text-zinc-500");

  const id = `f_${field.name}`;
  const set = (v: any) => onChange(field.name, v);

  function control() {
    switch (field.type) {
      case "textarea":
        return (
          <textarea
            id={id}
            className={classNames(inputBase, "min-h-24")}
            placeholder={field.placeholder}
            value={value ?? ""}
            onChange={(e) => set(e.target.value)}
          />
        );
      case "select":
        return (
          <select id={id} className={inputBase} value={value ?? ""} onChange={(e) => set(e.target.value)}>
            <option value="" disabled>
              {field.placeholder || "Select…"}
            </option>
            {(field.options || []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        );
      case "radio":
        return (
          <div className="flex flex-col gap-1">
            {(field.options || []).map((opt) => (
              <label key={opt} className={classNames("flex items-center gap-2", labelCls)}>
                <input
                  type="radio"
                  name={field.name}
                  value={opt}
                  checked={value === opt}
                  onChange={() => set(opt)}
                />
                {opt}
              </label>
            ))}
          </div>
        );
      case "checkbox":
        // Options present → a group of checkboxes (array value); otherwise a single boolean.
        if (field.options && field.options.length > 0) {
          const arr: string[] = Array.isArray(value) ? value : [];
          return (
            <div className="flex flex-col gap-1">
              {field.options.map((opt) => (
                <label key={opt} className={classNames("flex items-center gap-2", labelCls)}>
                  <input
                    type="checkbox"
                    checked={arr.includes(opt)}
                    onChange={(e) =>
                      set(e.target.checked ? [...arr, opt] : arr.filter((o) => o !== opt))
                    }
                  />
                  {opt}
                </label>
              ))}
            </div>
          );
        }
        return (
          <label className={classNames("flex items-center gap-2", labelCls)}>
            <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
            {field.label}
          </label>
        );
      default:
        return (
          <input
            id={id}
            type={field.type === "text" ? "text" : field.type}
            className={inputBase}
            placeholder={field.placeholder}
            value={value ?? ""}
            onChange={(e) => set(e.target.value)}
          />
        );
    }
  }

  const showTopLabel = !(field.type === "checkbox" && !(field.options && field.options.length));

  return (
    <div className="flex flex-col gap-1">
      {showTopLabel && field.label && (
        <label htmlFor={id} className={labelCls}>
          {field.label}
          {field.required && <span className="text-red-500"> *</span>}
        </label>
      )}
      {control()}
      {field.help && <span className={helpCls}>{field.help}</span>}
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
