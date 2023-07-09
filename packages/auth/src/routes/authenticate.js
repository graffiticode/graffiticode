import { addHexPrefix, isValidAddress } from "@ethereumjs/util";
import { InvalidArgumentError } from "@graffiticode/common/errors";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { Router } from "express";

const buildEthereumGetNonce = ({ ethereumService }) => buildHttpHandler(async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(addHexPrefix(address))) {
    throw new InvalidArgumentError(`invalid address: ${address}`);
  }
  const nonce = await ethereumService.getNonce({ address });
  sendSuccessResponse(res, nonce);
});

const buildEthereumAuthenticate = ({ authService, ethereumService }) => buildHttpHandler(async (req, res) => {
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

  const authContext = await ethereumService.authenticate({ address, nonce, signature });

  const { refreshToken: refresh_token, accessToken: access_token } = await authService.generateTokens(authContext);

  sendSuccessResponse(res, { refresh_token, access_token });
});

const buildEthereumRouter = ({ authService, ethereumService }) => {
  const router = new Router();
  router.get("/:address", buildEthereumGetNonce({ ethereumService }));
  router.post("/:address", buildEthereumAuthenticate({ authService, ethereumService }));
  return router;
};

export const buildAuthenticateRouter = deps => {
  const router = new Router();
  router.use("/ethereum", buildEthereumRouter(deps));
  return router;
};
