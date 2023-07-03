import { createApp } from "../app.js";
import { createClient } from "../client/remote.js";

export const startAuthApp = async () => {
  const deps = createApp();
  let server;

  await new Promise(resolve => {
    server = deps.app.listen(resolve);
  });

  const url = `http://localhost:${server.address().port}`;
  const client = createClient(url);

  const cleanUp = async () => {
    await new Promise(resolve => server.close(resolve));
  };

  return { ...deps, url, client, cleanUp };
};
