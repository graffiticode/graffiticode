import { addHexPrefix, isValidAddress } from "@ethereumjs/util";
import { InvalidArgumentError } from "@graffiticode/common/src/errors.js";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/src/http.js";
import { isNonEmptyString } from "@graffiticode/common/src/utils.js";
import { Router } from "express";

const buildEthereumGetNonce = ({ ethereum }) => buildHttpHandler(async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(addHexPrefix(address))) {
    throw new InvalidArgumentError(`invalid address: ${address}`);
  }
  const nonce = await ethereum.getNonce({ address });
  sendSuccessResponse(res, nonce);
});

const buildEthereumAuthenticate = ({ auth, ethereum }) => buildHttpHandler(async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(addHexPrefix(address))) {
    throw new InvalidArgumentError(`invalid address: ${address}`);
  }
  let { nonce, signature } = req.body;
  if (!isNonEmptyString(nonce)) {
    throw new InvalidArgumentError("must provide a nonce");
  }
  signature = addHexPrefix(signature);
  if (!isNonEmptyString(signature)) {
    throw new InvalidArgumentError("must provide a signature");
  }

  const authContext = await ethereum.authenticate({ address, nonce, signature });

  const { refreshToken: refresh_token, accessToken: access_token } = await auth.generateTokens(authContext);

  sendSuccessResponse(res, { refresh_token, access_token });
});

const buildEthereumRouter = ({ auth, ethereum }) => {
  const router = new Router();
  router.get("/:address", buildEthereumGetNonce({ ethereum }));
  router.post("/:address", buildEthereumAuthenticate({ auth, ethereum }));
  return router;
};

export const buildAuthenticateRouter = deps => {
  const router = new Router();
  router.use("/ethereum", buildEthereumRouter(deps));
  return router;
};
