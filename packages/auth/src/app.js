import { createApp } from "./routes/index.js";
import { buildAuthService } from "./services/auth.js";
import { buildEthereumService } from "./services/ethereum.js";
import { buildKeysService } from "./services/keys.js";
import { createStorers } from "./storage/index.js";

const createAppWithStorageType = (storageType) => {
  const { ethereumStorer, keyStorer, tokenStorer } = createStorers(storageType);

  const keys = buildKeysService({ keyStorer });
  const auth = buildAuthService({ tokenStorer, keys });
  const ethereum = buildEthereumService({ ethereumStorer });

  const app = createApp({ auth, ethereum, keys });

  return { ethereumStorer, keyStorer, tokenStorer, auth, ethereum, keys, app };
};

export const createAppWithFirestoreStorage = () => {
  return createAppWithStorageType("firestore");
};

export const createAppWithMemoryStorage = () => {
  return createAppWithStorageType("memory");
};
