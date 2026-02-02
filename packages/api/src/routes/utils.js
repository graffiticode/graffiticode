import { isNonEmptyString, getClientHost, getClientPort } from "../util.js";
import { HttpError } from "./../errors/http.js";
import { decodeID } from "./../id.js";
import { gql, GraphQLClient } from "graphql-request";

const normalizeIds = ids => ids.map(id => id.split(/[ ]/g).join("+"));

export const parseIdsFromRequest = req => {
  const id = req.query.id;
  if (isNonEmptyString(id)) {
    return normalizeIds(id.split(","));
  }
  return [];
};

export const parseOriginFromRequest = req => {
  return req.query.origin;
};

export const parseAuthFromRequest = req => {
  const { access_token: queryAuth } = req.query;
  if (isNonEmptyString(queryAuth)) {
    return queryAuth;
  }
  const { auth: bodyAuth } = req.body;
  if (isNonEmptyString(bodyAuth)) {
    return bodyAuth;
  }
  return null;
};

export const parseAuthTokenFromRequest = req => {
  const { access_token: queryAccessToken } = req.query;
  if (isNonEmptyString(queryAccessToken)) {
    return queryAccessToken;
  }
  let headerAuthToken = req.get("Authorization");
  if (isNonEmptyString(headerAuthToken)) {
    if (headerAuthToken.startsWith("Bearer ")) {
      headerAuthToken = headerAuthToken.slice("Bearer ".length);
    }
    return headerAuthToken;
  }
  return null;
};

const handleError = (err, res, next) => {
  if (err instanceof HttpError) {
    res
      .status(err.statusCode)
      .json(createErrorResponse(createError(err.code, err.message)));
  } else {
    next(err);
  }
};

export const buildHttpHandler = handler => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (err) {
    handleError(err, res, next);
  }
};

export const createError = (code, message) => ({ code, message });

export const createErrorResponse = error => ({ status: "error", error });

export const createCompileSuccessResponse = ({ id, data }) => ({ status: "success", id, data });

export const createSuccessResponse = ({ data }) => ({ status: "success", data });

export const getStorageTypeForRequest = req => {
  return (
    req.get("x-graffiticode-storage-type") || "ephemeral"
  );
};

export const getStorageTypeForId = id => {
  try {
    const ids = decodeID(id);
    if (ids[1] === 0) {
      // [_, 0, _] means invalid id.
      return "persistent";
    }
    return "ephemeral";
  } catch (x) {
    // Just in case.
    return "persistent";
  }
};

export const optionsHandler = buildHttpHandler(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Request-Methods", "POST, GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "X-PINGOTHER, Content-Type");
  res.set("Connection", "Keep-Alive");
  res.sendStatus(204);
});

export const buildCompileLogger = () => {
  const host = getClientHost();
  const port = getClientPort();
  const protocol = host.indexOf("localhost") >= 0 && "http" || "https";
  const endpoint = `${protocol}://${host}:${port}/api`;
  return ({ token, units, id, status, timestamp, data }) => {
    if (!token) {
      return Promise.resolve(null);
    }
    const client = new GraphQLClient(endpoint, {
      headers: {
        Authorization: token
      }
    });
    const query = gql`
    mutation post ($units: Int, $id: String!, $status: String!, $timestamp: String!, $data: String!) {
      logCompile(units: $units, id: $id, status: $status, timestamp: $timestamp, data: $data)
    }
  `;
    return client.request(query, { units, id, status, timestamp, data: JSON.stringify(data) })
      .then(result => {
        // Parse the logCompile response (returns JSON string)
        try {
          const logResult = JSON.parse(result?.logCompile || "{}");
          return logResult;
        } catch {
          return null;
        }
      })
      .catch(() => {
        // Silently ignore logging errors - this is fire-and-forget telemetry
        // Logging failures should never break the actual compilation flow
        return null;
      });
  };
};

// In-memory cache for compile allowed status
// Key: uid, Value: { allowed: boolean, expires: number }
const compileAllowedCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const getCachedCompileAllowed = (uid) => {
  const entry = compileAllowedCache.get(uid);
  if (entry && entry.allowed && Date.now() < entry.expires) {
    return true;
  }
  return null; // unknown or blocked - must verify
};

export const setCachedCompileAllowed = (uid, allowed) => {
  if (allowed) {
    compileAllowedCache.set(uid, { allowed: true, expires: Date.now() + CACHE_TTL_MS });
  } else {
    compileAllowedCache.delete(uid);
  }
};

export const checkCompileAllowedRemote = async (token) => {
  const host = getClientHost();
  const port = getClientPort();
  const protocol = host.indexOf("localhost") >= 0 ? "http" : "https";
  const url = `${protocol}://${host}${port ? ":" + port : ""}/api`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token
      },
      body: JSON.stringify({
        query: "{ checkCompileAllowed { allowed reason } }"
      })
    });

    if (!response.ok) {
      console.error("checkCompileAllowedRemote: HTTP error", response.status, response.statusText);
      return { allowed: false, reason: `Usage check failed (HTTP ${response.status})` };
    }

    const data = await response.json();

    // Check for GraphQL errors
    if (data.errors?.length > 0) {
      console.error("checkCompileAllowedRemote: GraphQL errors", data.errors);
      return { allowed: false, reason: data.errors[0]?.message || "GraphQL error" };
    }

    return data.data?.checkCompileAllowed || { allowed: false, reason: "Unknown error" };
  } catch (error) {
    console.error("checkCompileAllowedRemote error:", error.message || error);
    return { allowed: false, reason: "Failed to check usage limit" };
  }
};
