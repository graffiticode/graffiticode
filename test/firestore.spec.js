import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import fs from "fs";
import http from "http";
import { setDoc, doc, getDoc } from "firebase/firestore";

const PROJECT_ID = "graffiticode";
const COVERAGE_URL = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}:ruleCoverage.html`;

const MY_UID = "abc123";
const OTHER_UID = "def456";

describe("graffiticode/firestore", () => {
  let testEnv;
  beforeEach(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: "127.0.0.1",
        port: 8080,
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

  afterAll(async () => {
    const coverageFile = "firestore-coverage.html";
    const fstream = fs.createWriteStream(coverageFile);
    await new Promise((resolve, reject) => {
      http.get(COVERAGE_URL, (res) => {
        res.pipe(fstream, { end: true });
        res.on("end", resolve);
        res.on("error", reject);
      });
    });

    console.log(`View firestore rule coverage information at ${coverageFile}\n`);
  });

  describe("keys", () => {
    it("should not allow read ", async () => {
      const myUser = testEnv.authenticatedContext(MY_UID, { isAdmin: true });

      await assertFails(getDoc(doc(myUser.firestore(), "/keys/current")));
    });
  });

  describe("nonces", () => {
    it("should not allow read ", async () => {
      const myUser = testEnv.authenticatedContext(MY_UID, { isAdmin: true });

      await assertFails(getDoc(doc(myUser.firestore(), "/nonces/nonce")));
    });
  });

  describe("refreshTokens", () => {
    it("should allow my user to read ", async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await assertSucceeds(setDoc(doc(context.firestore(), "/refreshTokens/foo"), { uid: MY_UID }));
      });
      const myUser = testEnv.authenticatedContext(MY_UID);

      await assertSucceeds(getDoc(doc(myUser.firestore(), "/refreshTokens/foo")));
    });

    it("should not allow other user to read ", async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await assertSucceeds(setDoc(doc(context.firestore(), "/refreshTokens/foo"), { uid: MY_UID }));
      });
      const otherUser = testEnv.authenticatedContext(OTHER_UID);

      await assertFails(getDoc(doc(otherUser.firestore(), "/refreshTokens/foo")));
    });

    it("should allow admin user to read ", async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await assertSucceeds(setDoc(doc(context.firestore(), "/refreshTokens/foo"), { uid: MY_UID }));
      });
      const otherUser = testEnv.authenticatedContext(OTHER_UID, { isAdmin: true });

      await assertSucceeds(getDoc(doc(otherUser.firestore(), "/refreshTokens/foo")));
    });
  });
});
