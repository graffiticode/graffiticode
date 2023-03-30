import { NotFoundError } from "../../errors/http.js";
import { generateKey } from "../../services/keys.js";
import { cleanUpFirebase } from "../../testing/firebase.js";
import { createKeyStorer } from "./index.js";

describe.each(["memory", "firestore"])("storage/keys[%s]", (type) => {
  let keyStorer;
  beforeEach(async () => {
    keyStorer = createKeyStorer(type);
  });

  afterEach(cleanUpFirebase);

  it("should list created keys", async () => {
    const [key1, key2] = await Promise.all([generateKey(), generateKey()]);
    await Promise.all([keyStorer.create(key1), keyStorer.create(key2)]);

    const keys = await keyStorer.list();

    expect(keys).toEqual(expect.arrayContaining([
      expect.objectContaining(key1),
      expect.objectContaining(key2)
    ]));
  });

  it("should throw NotFoundError if not current key", async () => {
    await expect(keyStorer.getCurrent()).rejects.toThrow(NotFoundError);
  });

  it("should get current key", async () => {
    const key = await generateKey();
    const kid = await keyStorer.create(key);
    await keyStorer.setCurrent(kid);

    await expect(keyStorer.getCurrent()).resolves.toEqual(expect.objectContaining(key));
  });
});
