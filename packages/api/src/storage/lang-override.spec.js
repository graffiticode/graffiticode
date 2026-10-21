import { admin } from "./firebase.js";
import { bindingFor, buildLangOverrideStorer } from "./lang-override.js";
import { clearFirestore } from "../testing/firestore.js";

describe("storage/lang-override", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  let langOverrideStorer;
  beforeEach(() => {
    langOverrideStorer = buildLangOverrideStorer();
  });

  const seed = async (uid, bindings) => {
    await admin.firestore().doc(`lang-overrides/${uid}`).set({ bindings });
  };

  describe("get", () => {
    it("should return undefined when uid is falsy", async () => {
      await expect(langOverrideStorer.get({ uid: undefined })).resolves.toBe(undefined);
    });

    it("should return undefined when no doc exists", async () => {
      await expect(langOverrideStorer.get({ uid: "nobody" })).resolves.toBe(undefined);
    });

    it("should return the seeded doc", async () => {
      const bindings = { L0175: "https://test42---l0175.example.run.app" };
      await seed("user-1", bindings);
      await expect(langOverrideStorer.get({ uid: "user-1" })).resolves.toMatchObject({ bindings });
    });
  });

  describe("getBaseUrl", () => {
    it("should return undefined when uid is falsy", async () => {
      await seed("user-1", { L0175: "https://x.example.run.app" });
      await expect(langOverrideStorer.getBaseUrl({ uid: undefined, lang: "L0175" })).resolves.toBe(undefined);
    });

    it("should return undefined when the user has no override doc", async () => {
      await expect(langOverrideStorer.getBaseUrl({ uid: "nobody", lang: "L0175" })).resolves.toBe(undefined);
    });

    it("should return undefined when the lang is not bound", async () => {
      await seed("user-1", { L0137: "https://other.example.run.app" });
      await expect(langOverrideStorer.getBaseUrl({ uid: "user-1", lang: "L0175" })).resolves.toBe(undefined);
    });

    it("should return the bound base url, matching case-insensitively", async () => {
      const url = "https://test42---l0175.example.run.app";
      await seed("user-1", { L0175: url });
      await expect(langOverrideStorer.getBaseUrl({ uid: "user-1", lang: "l0175" })).resolves.toBe(url);
    });
  });

  describe("bindingFor", () => {
    const url = "https://test42---l0175.example.run.app";

    it("normalizes the lang to the doc's key", () => {
      for (const lang of ["L0175", "l0175", "0175"]) {
        expect(bindingFor({ L0175: url }, lang)).toBe(url);
      }
    });

    it("returns null for anything but a non-empty string binding", () => {
      expect(bindingFor({ L0175: "" }, "L0175")).toBeNull();
      expect(bindingFor({ L0175: 42 }, "L0175")).toBeNull();
      expect(bindingFor({ L0175: null }, "L0175")).toBeNull();
      expect(bindingFor({ L0137: url }, "L0175")).toBeNull();
      expect(bindingFor(undefined, "L0175")).toBeNull();
      expect(bindingFor("https://not-a-map", "L0175")).toBeNull();
    });

    it("leaves getBaseUrl answering undefined for those, so the resolver falls back", async () => {
      await seed("user-1", { L0175: "", L0137: 42 });
      await expect(langOverrideStorer.getBaseUrl({ uid: "user-1", lang: "L0175" })).resolves.toBe(undefined);
      await expect(langOverrideStorer.getBaseUrl({ uid: "user-1", lang: "L0137" })).resolves.toBe(undefined);
    });
  });

  describe("memoization", () => {
    it("serves the cached override within the TTL without re-reading", async () => {
      await seed("user-1", { L0175: "https://first.example.run.app" });
      await expect(langOverrideStorer.getBaseUrl({ uid: "user-1", lang: "L0175" }))
        .resolves.toBe("https://first.example.run.app");

      // Change the doc; within the memo TTL the storer keeps serving the cached
      // value (proving the second lookup did not hit Firestore).
      await seed("user-1", { L0175: "https://second.example.run.app" });
      await expect(langOverrideStorer.getBaseUrl({ uid: "user-1", lang: "L0175" }))
        .resolves.toBe("https://first.example.run.app");
    });

    it("caches the miss so a normal user does not read per lookup", async () => {
      await expect(langOverrideStorer.get({ uid: "nobody" })).resolves.toBe(undefined);
      // Seed after the miss is cached; within the TTL the cached miss still wins.
      await seed("nobody", { L0175: "https://x.example.run.app" });
      await expect(langOverrideStorer.get({ uid: "nobody" })).resolves.toBe(undefined);
    });
  });
});
