import { spawn } from "node:child_process";

// No shell interpolation: configuration and paths are always individual arguments.
// @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
export function run(command, args, { cwd, stream = false, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", stream ? "inherit" : "pipe", "inherit"] });
    let output = "";
    child.stdout?.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(raw ? output : output.trim()) : reject(new Error(`${command} ${args.slice(0, 3).join(" ")} failed (${code})`)));
  });
}

// A long-running command whose output goes straight to the terminal, for
// progress only: `done` settles when it exits, `stop` ends it early.
/** @param {string} command @param {string[]} args @param {{ cwd?: string }} [options] */
export function streamOutput(command, args, { cwd } = {}) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 || signal ? resolve(undefined) : reject(new Error(`${command} ${args.slice(0, 3).join(" ")} failed (${code})`)));
  });
  return { done, stop: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); } };
}
