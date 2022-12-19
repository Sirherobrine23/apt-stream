#!/usr/bin/env node
import yargs from "yargs";
import repo from "./apt_repo_v2.js";
import { getConfig } from "./repoConfig.js";
import github_release from "./githubRelease.js";
import oci_registry from "./oci_registry.js";

yargs(process.argv.slice(2)).wrap(null).strict().help().option("cofig-path", {
  type: "string",
  default: process.cwd()+"/repoconfig.yml",
}).option("port", {
  type: "number",
  default: 3000,
}).parseAsync().then(async options => {
  const { app, registry } = await repo();
  app.listen(options.port, () => {
    console.log(`Server listening on port ${options.port}`);
  });
  Promise.all((await getConfig(options["cofig-path"])).repos.map(async repo => {
    if (repo.from === "oci") return oci_registry({image: repo.repo, targetInfo: repo.ociConfig}, data => registry.pushPackage(data.control, data.getStream)).catch(console.error);
    else if (repo.from === "release") return github_release({config: repo.repo, githubToken: repo.auth.password}, data => registry.pushPackage(data.control, data.getStream)).catch(console.error);
  })).catch(console.error);
});