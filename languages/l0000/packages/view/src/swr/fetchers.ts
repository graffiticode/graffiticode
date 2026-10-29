// SPDX-License-Identifier: MIT
import { postApiCompile, getApiDataLoad, type DataGenerations } from "../lib/api";

export const compile = async ({
  accessToken,
  id,
  data,
  generation,
}: {
  accessToken?: string;
  id: string;
  data: any;
  generation?: string;
}) => {
  // Empty data → recompile the full id; otherwise recompile with the code id only.
  const index = Object.keys(data).length > 0 ? 1 : 2;
  id = id.split("+").slice(0, index).join("+");
  return await postApiCompile({ accessToken, id, data, generation });
};

export const getData = async ({
  accessToken,
  id,
  connection,
  publication,
  generation,
  generations,
}: {
  accessToken?: string;
  id: string;
  connection?: string;
  publication?: string;
} & DataGenerations) => {
  return await getApiDataLoad({ accessToken, id, connection, publication, generation, generations });
};
