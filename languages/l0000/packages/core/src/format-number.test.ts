import { describe, test, expect } from "vitest";
import DecimalImport from "decimal.js";
import { formatNumber, FormatPatternError } from "@graffiticode/l0000";

const Decimal: any = (DecimalImport as any)?.default ?? DecimalImport;

describe("formatNumber", () => {
  test.each([
    // placeholders, decimal point and grouping
    ["#,##0.00", 1234.5, "1,234.50"],
    ["0", 0, "0"],
    ["#", 0, ""],
    [".00", 0.5, ".50"],
    [".00", 12.5, "12.50"],
    ["#.##", 1, "1."],
    ["0,000", 5, "0,005"],
    ["??0.0?", 1.5, "  1.5 "],
    ["000-00-0000", 123456789, "123-45-6789"],
    // percent and scaling commas
    ["0.0%", 0.256, "25.6%"],
    ["#,##0,,\"M\"", 1234567890, "1,235M"],
    ["0.0,", 1500, "1.5"],
    // literal text
    ["$#,##0", 1234567.8, "$1,234,568"],
    ["0 \"kg\"", 3, "3 kg"],
    ["\\#0", 7, "#7"],
    ["0_)", 7, "7 "],
    ["*-0", 7, "7"],
    // rounding: half away from zero, in decimal
    ["0", 2.5, "3"],
    ["0", -2.5, "-3"],
    ["0.00", 1.005, "1.01"],
    ["0.00", -0.001, "0.00"],
    // sections
    ["#,##0;(#,##0)", -1500, "(1,500)"],
    ["#,##0;(#,##0)", 1500, "1,500"],
    ["0.00;(0.00)", -0.001, "(0.00)"],
    ["0;-0;\"zero\"", 0, "zero"],
    ["0;-0;\"zero\"", -0, "zero"],
    ["#,##0.00_);(#,##0.00)", -1234.5, "(1,234.50)"],
    ["#,##0.00_);(#,##0.00)", 1234.5, "1,234.50 "],
    // scientific: E+ always signs the exponent; E- and the unsigned E only a minus
    ["0.00E+00", 12345, "1.23E+04"],
    ["0.00E+00", 0.00123, "1.23E-03"],
    ["0.00E-00", 12345, "1.23E04"],
    ["0.00E-00", 0.00123, "1.23E-03"],
    ["0.00e00", 12345, "1.23e04"],
    ["0.00e00", 0.00123, "1.23e-03"],
    ["0.00e+00", 12345, "1.23e+04"],
    ["0.00E+00", 9.999, "1.00E+01"],
    ["0.0E+00", 0, "0.0E+00"],
    ["##0.0E+0", 12345, "12.3E+3"],
    // General
    ["General", 0.1, "0.1"],
    ["General\" kg\"", -3.25, "-3.25 kg"],
  ])("%s formats %s as %j", (pattern, value, expected) => {
    expect(formatNumber(pattern, value)).toBe(expected);
  });

  test("a Decimal keeps every digit", () => {
    expect(formatNumber("#,##0", new Decimal("12345678901234567891"))).toBe("12,345,678,901,234,567,891");
    expect(formatNumber("0.0%", new Decimal("12345678901234567891"))).toBe("1234567890123456789100.0%");
  });

  test.each([
    ["", "the pattern is empty"],
    ["[Red]0", "[…] (colors, conditions and locales) is not supported"],
    ["@", "@ (text sections) is not supported"],
    ["0;0;0;0", "at most three sections"],
    ["0/0", "fractions"],
    ["yyyy", "date and time codes are not supported"],
    ["0 kg", "'k': put literal text in double quotes"],
    ["1", "put literal digits in double quotes"],
    ["\"open", "a quoted string is not closed"],
    ["0\\", "needs a character after it"],
    ["General0", "General cannot be combined with digit placeholders"],
  ])("rejects %j", (pattern, message) => {
    expect(() => formatNumber(pattern, 1)).toThrow(FormatPatternError);
    expect(() => formatNumber(pattern, 1)).toThrow(message);
  });

  test("rejects a value that is not finite", () => {
    expect(() => formatNumber("0", NaN)).toThrow(RangeError);
    expect(() => formatNumber("0", Infinity)).toThrow(RangeError);
  });
});
