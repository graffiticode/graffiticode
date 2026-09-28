import { spawn } from "node:child_process";

// No shell interpolation: configuration and paths are always individual arguments.
export function run(command, args, { cwd, stream = false, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", stream ? "inherit" : "pipe", "inherit"] });
    let output = "";
    child.stdout?.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(raw ? output : output.trim()) : reject(new Error(`${command} ${args.slice(0, 3).join(" ")} failed (${code})`)));
  });
}
