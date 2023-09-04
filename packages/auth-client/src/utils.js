export const getDataOrThrowError = async ({ status, error, data }) => {
  if (status !== "success") {
    const err = new Error(error.message);
    err.code = error.code;
    throw err;
  }
  return data;
};
