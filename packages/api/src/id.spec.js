import { decodeID, encodeID } from "./id.js";

describe("id", () => {
  describe("decodeID", () => {
    const expectIds = (ids, ...params) => {
      expect(ids).toHaveLength(params.length);
      for (let i = 0; i < ids.length; i++) {
        expect(ids[i]).toBe(params[i]);
      }
    };
    it("should return 0 when no ID", () => {
      const ids = decodeID();
      expectIds(ids, 0, 0, 0);
    });
    it("should return ID when integer input", () => {
      const ids = decodeID(123);
      expectIds(ids, 0, 123, 0);
    });
    it("should return ID when single ID", () => {
      const ids = decodeID("123456");
      expectIds(ids, 0, 123456, 0);
    });
    it("should return ID with multiple parts", () => {
      const ids = decodeID("123+534653+0");
      expectIds(ids, 123, 534653, 0);
    });
    it("should return 0 ID when invalid ID", () => {
      const ids = decodeID("Px4xO423c");
      expectIds(ids, 0, 0, 0);
    });
    it("should return legacy lang+code+data ID", () => {
      const ids = decodeID("123+123456+0+Px4xO423c");
      expectIds(ids, 0, 123, 113, 123456, 0);
    });
    it("should return 0 ID when multipart invalid ID", () => {
      const ids = decodeID("Px4xO423c+Px4xO423c");
      expectIds(ids, 0, 0, 0);
    });
  });
  describe("encodeID", () => {
    it("should encode single ID", () => {
      const encoded = encodeID([42]);
      expect(encoded).toBe("z3iqiO");
    });
    it("should encode single zero ID", () => {
      const encoded = encodeID([0]);
      expect(encoded).toBe("0");
    });
    it("should encode legacy ID", () => {
      const encoded = encodeID([42, 13]);
      expect(encoded).toBe("J0iKiRaHOcp");
    });
    it("should encode with trailing zeros", () => {
      const encoded = encodeID([42, 0, 0, 0]);
      expect(encoded).toBe("QOiVi4OsOi7");
    });
  });
});
