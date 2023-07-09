import { randomBytes } from "node:crypto";

export const generateNonce = (size = 32) =>
  new Promise((resolve, reject) =>
    randomBytes(size, (err, buf) => {
      if (err) {
        reject(err);
      } else {
        resolve(buf.toString("hex"));
      }
    }));
