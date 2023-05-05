import { createHttpApp } from "@graffiticode/common/src/http.js";

import { buildAuthenticateRouter } from "./authenticate.js";
import { buildCertsRouter } from "./certs.js";
import { buildOAuthRouter } from "./oauth.js";

export const createApp = deps => {
  return createHttpApp(app => {
    app.use("/authenticate", buildAuthenticateRouter(deps));
    app.use("/oauth", buildOAuthRouter(deps));
    app.use("/certs", buildCertsRouter(deps));
  });
};
