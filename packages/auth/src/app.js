import { getAuth } from "./firebase.js";
import { createHttpAuthApp } from "./routes/index.js";
import { createServices } from "./services/index.js";
import { createStorers } from "./storage/index.js";

export const createApp = () => {
  const firebaseAuth = getAuth();

  const storers = createStorers({ firebaseAuth });
  const services = createServices({ firebaseAuth, ...storers });
  const app = createHttpAuthApp({ firebaseAuth, ...storers, ...services });
  return { ...storers, ...services, app };
};

