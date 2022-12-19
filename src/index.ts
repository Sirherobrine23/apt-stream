#!/usr/bin/env node
import yargs from "yargs";
import repo from "./apt_repo_v2.js";
import { getConfig } from "./repoConfig.js";
import github_release from "./githubRelease.js";
import oci_registry from "./oci_registry.js";
import { CronJob } from "cron";

yargs(process.argv.slice(2)).wrap(null).strict().help().option("cofig-path", {
  type: "string",
  default: process.cwd()+"/repoconfig.yml",
}).option("port", {
  type: "number",
  default: 3000,
}).parseAsync().then(async options => {
  const config = await getConfig(options["cofig-path"]);
  const { app, registry } = await repo(config);
  app.listen(options.port, () => console.log(`Server listening on port ${options.port}`));
  for (const repo of config.repositories) {
    console.log(repo);
    const sen = () => Promise.resolve().then(async () => {
      if (repo.from === "github_release") {
        const tags = repo.tags ?? ["latest"];
        if (tags.length === 0) tags.push("latest");
        return Promise.all(tags.map(async tag => github_release({
          githubToken: repo.token,
          config: {
            owner: repo.owner,
            repo: repo.repository,
            releaseTag: tag,
          }
        }, ({control, getStream}) => registry.pushPackage(control, getStream))));
      } else if (repo.from === "oci") {
        return oci_registry({
          image: repo.image,
          targetInfo: repo.platfom_target,
        }, ({control, getStream}) => registry.pushPackage(control, getStream));
      }
      return null;
    }).catch(console.trace);
    sen();
    const cronJobs = repo.cronRefresh ?? [];
    const jobs = cronJobs.map(cron => new CronJob(cron, sen));
    jobs.forEach(job => job.start());
  }
});