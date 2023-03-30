import { buildMemoryEthereumStorer } from "./ethereum/memory.js";
import { buildMemoryKeyStorer } from "./keys/memory.js";
import { buildMemoryTokenStorer } from "./tokens/memory.js";

export const buildMemoryStorers = () => {
  const ethereumStorer = buildMemoryEthereumStorer();
  const keyStorer = buildMemoryKeyStorer();
  const tokenStorer = buildMemoryTokenStorer();
  return { ethereumStorer, keyStorer, tokenStorer };
};
