import { createHttpApp } from "@graffiticode/common/http";

import { buildApiKeysRouter } from "./api-keys.js";
import { buildGraffiticodeAuthenticator } from "./auth.js";
import { buildAuthenticateRouter } from "./authenticate.js";
import { buildCertsRouter } from "./certs.js";
import { buildOAuthRouter } from "./oauth.js";
import { buildOAuthLinksRouter } from "./oauth-links.js";
import { buildOAuthTokensRouter } from "./oauth-tokens.js";
import { buildV1Router } from "./v1/index.js";

export const createHttpAuthApp = deps => {
  return createHttpApp(app => {
    app.use(buildGraffiticodeAuthenticator(deps));

    app.use("/api-keys", buildApiKeysRouter(deps));
    app.use("/authenticate", buildAuthenticateRouter(deps));
    app.use("/certs", buildCertsRouter(deps));
    app.use("/oauth", buildOAuthRouter(deps));
    app.use("/oauth-links", buildOAuthLinksRouter(deps));
    app.use("/oauth-tokens", buildOAuthTokensRouter(deps));
    app.use("/v1", buildV1Router(deps));
  });
};
