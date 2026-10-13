export const isNonEmptyString = (str: unknown): str is string => (typeof (str) === "string" && str.length > 0);
