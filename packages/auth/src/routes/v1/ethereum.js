import { addHexPrefix, isValidAddress } from "@ethereumjs/util";
import { InvalidArgumentError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { Router } from "express";

const buildGet = ({ ethereumService }) => buildHttpHandler(async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(addHexPrefix(address))) {
    throw new InvalidArgumentError(`invalid ethereum address ${address}`);
  }
  const nonce = await ethereumService.getNonce({ address });
  sendSuccessResponse(res, { nonce });
});

const buildAuthenticate = ({ ethereumService, authService }) => buildHttpHandler(async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(addHexPrefix(address))) {
    throw new InvalidArgumentError(`invalid ethereum address ${address}`);
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
  const { accessToken, refreshToken } = await authService.generateTokens(authContext);
  sendSuccessResponse(res, { accessToken, refreshToken });
});

export const buildEthereumRouter = (deps) => {
  const router = new Router();

  router.get("/:address", buildGet(deps));
  router.post("/:address/authenticate", buildAuthenticate(deps));

  return router;
};
