// SPDX-License-Identifier: MIT
import { postApiCompile, getApiData } from "../lib/api";

export const compile = async ({
  accessToken,
  id,
  data,
}: {
  accessToken?: string;
  id: string;
  data: any;
}) => {
  // Empty data → recompile the full id; otherwise recompile with the code id only.
  const index = Object.keys(data).length > 0 ? 1 : 2;
  id = id.split("+").slice(0, index).join("+");
  return await postApiCompile({ accessToken, id, data });
};

export const getData = async ({
  accessToken,
  id,
  connection,
  publication,
}: {
  accessToken?: string;
  id: string;
  connection?: string;
  publication?: string;
}) => {
  return await getApiData({ accessToken, id, connection, publication });
};
