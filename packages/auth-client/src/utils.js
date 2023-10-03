export const getDataOrThrowError = async (res) => {
  const { status, error, data } = res;
  if (status !== "success") {
    const err = new Error(error.message);
    err.code = error.code;
    throw err;
  }
  return data;
};
