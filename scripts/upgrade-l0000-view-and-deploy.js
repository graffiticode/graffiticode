// Upgrade each language's view to the latest @graffiticode/l0000-view and deploy it.
// See lib/upgrade-and-deploy.js for flags.
import { upgradeAndDeploy } from "./lib/upgrade-and-deploy.js";

// The shared View harness is inherited by each language's view, so the dep lives in
// packages/view.
upgradeAndDeploy({ pkg: "@graffiticode/l0000-view", targetPkg: "packages/view" });
