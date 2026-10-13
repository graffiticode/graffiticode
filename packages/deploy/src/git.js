import { spawn } from "node:child_process";
import { requireValue } from "./config.js";

const exitCode = (args, cwd) => new Promise((resolve, reject) => {
  const child = spawn("git", args, { cwd, stdio: "ignore" });
  child.on("error", reject);
  child.on("close", resolve);
});

// Commit ancestry from the local Git history at `root`. A commit it does not
// have is an error, not a "no": fetch first.
export const createGit = root => ({
  isAncestor: async (base, commit) => {
    for (const sha of [base, commit]) {
      requireValue(await exitCode(["cat-file", "-e", `${sha}^{commit}`], root) === 0, `commit ${sha} is not in the local history; run git fetch and retry`);
    }
    return (await exitCode(["merge-base", "--is-ancestor", base, commit], root)) === 0;
  },
});
