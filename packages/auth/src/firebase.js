import admin from "firebase-admin";

const ALLOWED_INITIALIZE_ERROR_CODES = ["app/duplicate-app"];

try {
  // In development with emulators, don't use service account credentials
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    console.log("Running with Firebase emulators, using project:", process.env.GOOGLE_CLOUD_PROJECT || "graffiticode");
    admin.initializeApp({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || "graffiticode"
    });
  } else {
    // Production mode - use default credentials
    admin.initializeApp();
  }
} catch (err) {
  if (!ALLOWED_INITIALIZE_ERROR_CODES.includes(err.code)) {
    console.log(err.code);
    throw err;
  }
}

export const getAuth = () => admin.auth();
export const getFirestore = () => admin.firestore();
