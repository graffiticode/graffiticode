// The client's shared state: tokens a sign-in stores and later calls fall back to.
export type Context = Map<string, string>;

// A bent JSON caller (bent ships no types): a path, then an optional body and headers.
export type JSONRequest = (path: string, body?: unknown, headers?: Record<string, string>) => Promise<any>;

// The auth service's response envelope.
export type AuthResponse = { status: string; error?: { message: string; code?: string }; data?: any };

export const getDataOrThrowError = async (res: AuthResponse): Promise<any> => {
  const { status, error, data } = res;
  if (status !== "success") {
    const err: Error & { code?: string } = new Error(error.message);
    err.code = error.code;
    throw err;
  }
  return data;
};
