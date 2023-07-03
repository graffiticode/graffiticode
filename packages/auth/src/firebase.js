import admin from "firebase-admin";

const ALLOWED_INITIALIZE_ERROR_CODES = ["app/duplicate-app"];

try {
  admin.initializeApp();
} catch (err) {
  if (!ALLOWED_INITIALIZE_ERROR_CODES.includes(err.code)) {
    console.log(err.code);
    throw err;
  }
}

export const getAuth = () => admin.auth();
export const getFirestore = () => admin.firestore();
