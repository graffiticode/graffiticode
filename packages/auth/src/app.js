import { createHttpAuthApp } from "./routes/index.js";
import { buildAuthService } from "./services/auth.js";
import { buildEthereumService } from "./services/ethereum.js";
import { buildKeysService } from "./services/keys.js";
import { createStorers } from "./storage/index.js";

export const createApp = () => {
  const { ethereumStorer, keyStorer, refreshTokenStorer } = createStorers();

  const keys = buildKeysService({ keyStorer });
  const auth = buildAuthService({ refreshTokenStorer, keys });
  const ethereum = buildEthereumService({ ethereumStorer });

  const app = createHttpAuthApp({ auth, ethereum, keys });

  return { ethereumStorer, keyStorer, refreshTokenStorer, auth, ethereum, keys, app };
};
