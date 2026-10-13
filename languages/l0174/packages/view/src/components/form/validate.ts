// SPDX-License-Identifier: MIT
// Client-side validation for L0174 form fields. Rules come straight off the compiled field
// record (flat: required, min/max, minLength/maxLength, pattern).

export interface FieldDef {
  type: string;
  name: string;
  label?: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  options?: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns an error message for `value` against `field`, or null when valid.
export function validateField(field: FieldDef, value: any): string | null {
  const label = field.label || field.name;
  const empty =
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    value === false;

  if (field.required && empty) {
    return `${label} is required.`;
  }
  // Nothing further to check on an empty optional field.
  if (empty) return null;

  const str = typeof value === "string" ? value : String(value);

  if (field.type === "email" && !EMAIL_RE.test(str)) {
    return `${label} must be a valid email address.`;
  }
  if (field.type === "url") {
    try {
      new URL(str);
    } catch {
      return `${label} must be a valid URL.`;
    }
  }
  if (field.minLength !== undefined && str.length < field.minLength) {
    return `${label} must be at least ${field.minLength} characters.`;
  }
  if (field.maxLength !== undefined && str.length > field.maxLength) {
    return `${label} must be at most ${field.maxLength} characters.`;
  }
  if ((field.type === "number" || field.type === "date") && field.min !== undefined) {
    const n = field.type === "number" ? Number(value) : Date.parse(str);
    const min = field.type === "number" ? field.min : Date.parse(String(field.min));
    if (!Number.isNaN(n) && !Number.isNaN(min) && n < min) {
      return `${label} must be at least ${field.min}.`;
    }
  }
  if ((field.type === "number" || field.type === "date") && field.max !== undefined) {
    const n = field.type === "number" ? Number(value) : Date.parse(str);
    const max = field.type === "number" ? field.max : Date.parse(String(field.max));
    if (!Number.isNaN(n) && !Number.isNaN(max) && n > max) {
      return `${label} must be at most ${field.max}.`;
    }
  }
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(str)) {
        return `${label} is not in the expected format.`;
      }
    } catch {
      /* ignore an invalid author-supplied pattern */
    }
  }
  return null;
}

// Validates every field; returns a map of field name -> error message for the invalid ones.
export function validateAll(fields: FieldDef[], values: Record<string, any>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const err = validateField(field, values[field.name]);
    if (err) errors[field.name] = err;
  }
  return errors;
}
