// SPDX-License-Identifier: MIT
import { describe, test, expect } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler } from "./compiler.js";
import { lexicon } from "./lexicon.js";

function compile(src: string, data: any = {}): Promise<any> {
  return parser.parse(0, src, lexicon).then(
    (code: any) =>
      new Promise((resolve, reject) => {
        compiler.compile(code, data, {}, (err: any, val: any) => {
          if (err && err.length > 0) reject(err);
          else resolve(val);
        });
      }),
  );
}

describe("L0174 forms", () => {
  describe("field elements", () => {
    test("a single text field stamps type and slugged name", async () => {
      const out = await compile("fields [ text label 'Full name' required true {} ] {}..");
      expect(out.fields).toEqual([
        { type: "text", name: "full_name", label: "Full name", required: true },
      ]);
    });

    test("explicit name attribute overrides the slug", async () => {
      const out = await compile("fields [ email label 'Email' name 'contact_email' {} ] {}..");
      expect(out.fields[0]).toMatchObject({
        type: "email",
        name: "contact_email",
        label: "Email",
      });
    });

    test("validation keys sit flat on the field", async () => {
      const out = await compile(
        "fields [ textarea label 'Message' required true minLength 20 {} ] {}..",
      );
      expect(out.fields[0]).toEqual({
        type: "textarea",
        name: "message",
        label: "Message",
        required: true,
        minLength: 20,
      });
    });

    test("number field carries min/max", async () => {
      const out = await compile(
        "fields [ number label 'Guests' min 0 max 5 {} ] {}..",
      );
      expect(out.fields[0]).toMatchObject({ type: "number", min: 0, max: 5 });
    });

    test("select field carries its options list", async () => {
      const out = await compile(
        "fields [ select label 'Topic' options ['Sales' 'Support' 'Other'] {} ] {}..",
      );
      expect(out.fields[0]).toMatchObject({
        type: "select",
        label: "Topic",
        options: ["Sales", "Support", "Other"],
      });
    });
  });

  describe("top-level chain", () => {
    test("assembles a flat form-definition record", async () => {
      const out = await compile(
        `title 'Get in touch'
         theme LIGHT
         fields [
           text  label 'Name'  required true {},
           email label 'Email' required true {}
         ]
         submit 'Send' {}..`,
      );
      expect(out).toEqual({
        title: "Get in touch",
        theme: "light",
        fields: [
          { type: "text", name: "name", label: "Name", required: true },
          { type: "email", name: "email", label: "Email", required: true },
        ],
        submit: { label: "Send" },
      });
    });

    test("theme DARK lowercases to dark", async () => {
      const out = await compile("theme DARK fields [ text label 'X' {} ] {}..");
      expect(out.theme).toBe("dark");
    });
  });

  describe("validation errors", () => {
    test("select without options is an error", async () => {
      await expect(
        compile("fields [ select label 'Topic' {} ] {}.."),
      ).rejects.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("requires a non-empty options list"),
          }),
        ]),
      );
    });

    test("a non-DARK/LIGHT theme value is an error", async () => {
      await expect(
        compile("theme 'blue' fields [ text label 'X' {} ] {}.."),
      ).rejects.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("theme expects the tag DARK or LIGHT"),
          }),
        ]),
      );
    });
  });
});
