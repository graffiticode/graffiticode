import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, getIdToken, signInWithCustomToken } from "firebase/auth";
import { getAuth as getAdminAuth, getFirestore } from "../firebase.js";

const firebaseConfig = {
  apiKey: "AIzaSyAoVuUNi8ElnS7cn6wc3D8XExML-URLw0I",
  authDomain: "graffiticode.firebaseapp.com",
  databaseURL: "https://graffiticode.firebaseio.com",
  projectId: "graffiticode",
  storageBucket: "graffiticode.appspot.com",
  messagingSenderId: "656973052505",
  appId: "1:656973052505:web:f3f3cc6397a844599c8f48",
  measurementId: "G-KRPK1CDB19"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });

export const signInAndGetIdToken = async (customToken) => {
  const { user } = await signInWithCustomToken(auth, customToken);
  const token = await getIdToken(user);
  return token;
};

export const cleanUpFirebase = async () => {
  // Clean up auth
  const auth = getAdminAuth();
  const { users } = await auth.listUsers();
  await auth.deleteUsers(users.map(user => user.uid));

  // Clean up firestore
  const db = getFirestore();
  const cols = await db.listCollections();
  await Promise.all(cols.map(c => db.recursiveDelete(c)));
};
