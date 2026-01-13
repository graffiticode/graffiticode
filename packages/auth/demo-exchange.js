import { startAuthApp } from "./src/testing/app.js";
import bent from "bent";

const run = async () => {
  // 1. Start the Auth Service
  console.log("Starting Auth Service...");
  const app = await startAuthApp();
  const { url, apiKeyService } = app;
  console.log(`Auth Service running at ${url}`);

  // 2. Setup: Create a user and an API Key
  // We can use the internal service directly to seed this data
  const uid = "test-user-123";
  console.log(`Creating API Key for user: ${uid}`);
  
  const { id, token } = await apiKeyService.create({ uid });
  console.log("--- Frontapp Credential ---");
  console.log("API Key ID:", id);
  console.log("API Key Secret:", token);
  console.log("---------------------------");

  // 3. Exchange: Perform the HTTP request to get the Session JWT
  console.log("\nExchanging Credential for Session JWT...");
  
  const postJSON = bent(url, "POST", "json", 200);
  
  try {
    const response = await postJSON(`/v1/api-keys/${id}/authenticate`, {
      token: token
    });

    console.log("--- Exchange Successful ---");
    console.log("Session JWT (Access Token):");
    console.log(response.data.accessToken);
    console.log("---------------------------");
    
  } catch (e) {
    console.error("Exchange Failed:", e);
    if (e.responseBody) {
      console.error(await e.responseBody);
    }
  }

  // 4. Cleanup
  await app.cleanUp();
};

run();
