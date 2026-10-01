export const getDataOrThrowError = async ({ status, error, data }) => {
  if (status !== "success") {
    const err = new Error(error.message);
    // @ts-expect-error TS-MIGRATE: custom field assigned on Error
    err.code = error.code;
    throw err;
  }
  return data;
};
