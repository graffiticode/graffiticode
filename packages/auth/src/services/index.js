import { buildAuthService } from "./auth.js";
import { buildEthereumService } from "./ethereum.js";
import { buildKeysService } from "./keys.js";

export const createServices = ({ ethereumStorer, keyStorer, refreshTokenStorer }) => {
  const keysService = buildKeysService({ keyStorer });
  const authService = buildAuthService({ refreshTokenStorer, keysService });
  const ethereumService = buildEthereumService({ ethereumStorer });

  return {
    keysService,
    authService,
    ethereumService,
  };
};
