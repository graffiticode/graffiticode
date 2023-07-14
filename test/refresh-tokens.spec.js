import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import fs from "fs";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";

const PROJECT_ID = "graffiticode";

const MY_UID = "abc123";
const OTHER_UID = "def456";

describe("graffiticode/firestore", () => {
  let testEnv;
  beforeEach(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: fs.readFileSync("firestore.rules", "utf8"),
      },
    });
  });

  afterEach(async () => {
    if (testEnv) {
      await testEnv.cleanup();
      testEnv = null;
    }
  });

  describe("refresh-tokens-private", () => {
    it("should not allow read", async () => {
      const myUser = testEnv.authenticatedContext(MY_UID, { isAdmin: true });

      await assertFails(getDoc(doc(myUser.firestore(), "refresh-tokens-private/my-api-key")));
    });
  });

  describe("refresh-tokens", () => {
    it("should not allow creates/updates", async () => {
      const myUser = testEnv.authenticatedContext(MY_UID, { isAdmin: true });

      await assertFails(setDoc(doc(myUser.firestore(), "refresh-tokens/foo"), { uid: MY_UID }));
    });

    it("should not allow deletes", async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await assertSucceeds(setDoc(doc(context.firestore(), "refresh-tokens/foo"), { uid: MY_UID }));
      });
      const myUser = testEnv.authenticatedContext(MY_UID, { isAdmin: true });

      await assertFails(deleteDoc(doc(myUser.firestore(), "refresh-tokens/foo"), { uid: MY_UID }));
    });

    it("should allow my user to read ", async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await assertSucceeds(setDoc(doc(context.firestore(), "refresh-tokens/foo"), { uid: MY_UID }));
      });
      const myUser = testEnv.authenticatedContext(MY_UID);

      await assertSucceeds(getDoc(doc(myUser.firestore(), "refresh-tokens/foo")));
    });

    it("should not allow other user to read ", async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await assertSucceeds(setDoc(doc(context.firestore(), "refresh-tokens/foo"), { uid: MY_UID }));
      });
      const otherUser = testEnv.authenticatedContext(OTHER_UID);

      await assertFails(getDoc(doc(otherUser.firestore(), "refresh-tokens/foo")));
    });

    it("should allow admin user to read ", async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await assertSucceeds(setDoc(doc(context.firestore(), "refresh-tokens/foo"), { uid: MY_UID }));
      });
      const otherUser = testEnv.authenticatedContext(OTHER_UID, { isAdmin: true });

      await assertSucceeds(getDoc(doc(otherUser.firestore(), "refresh-tokens/foo")));
    });
  });
});
