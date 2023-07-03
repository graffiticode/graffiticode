import { createHttpApp } from "@graffiticode/common/http";

import { buildAuthenticateRouter } from "./authenticate.js";
import { buildCertsRouter } from "./certs.js";
import { buildOAuthRouter } from "./oauth.js";

export const createHttpAuthApp = deps => {
  return createHttpApp(app => {
    app.use("/authenticate", buildAuthenticateRouter(deps));
    app.use("/certs", buildCertsRouter(deps));
    app.use("/oauth", buildOAuthRouter(deps));
  });
};
