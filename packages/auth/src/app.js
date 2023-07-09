import { createHttpAuthApp } from "./routes/index.js";
import { createServices } from "./services/index.js";
import { createStorers } from "./storage/index.js";

export const createApp = () => {
  const storers = createStorers();
  const services = createServices(storers);
  const app = createHttpAuthApp(services);
  return { ...storers, ...services, app };
};
