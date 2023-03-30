import { randomBytes } from "node:crypto";

export const isNonEmptyString = (str) => (typeof (str) === "string" && str.length > 0);

export const generateNonce = (size = 32) =>
  new Promise((resolve, reject) =>
    randomBytes(size, (err, buf) => {
      if (err) {
        reject(err);
      } else {
        resolve(buf.toString("hex"));
      }
    }));
