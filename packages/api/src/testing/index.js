import { jest } from "@jest/globals";
export const mockPromiseError = (err) => {
  return jest.fn().mockImplementation((...params) => {
    if (params.length > 0) {
      throw err;
    } else {
      throw new Error("no callback paramter given");
    }
  });
};

export const mockPromiseValue = (value) => {
  return jest.fn().mockImplementation((...params) => {
    return value;
  });
};
