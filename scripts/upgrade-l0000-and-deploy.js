// Upgrade each language's core to the latest @graffiticode/l0000 and deploy it.
// See lib/upgrade-and-deploy.js for flags.
import { upgradeAndDeploy } from "./lib/upgrade-and-deploy.js";

// The l0000 core is inherited by each language's core, so the dep lives in packages/core.
upgradeAndDeploy({ pkg: "@graffiticode/l0000", targetPkg: "packages/core" });
