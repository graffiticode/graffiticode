export const getDataOrThrowError = async (res) => {
  const { status, error, data } = res;
  if (status !== "success") {
    const err = new Error(error.message);
    // @ts-expect-error TS-MIGRATE: custom field assigned on Error
    err.code = error.code;
    throw err;
  }
  return data;
};
