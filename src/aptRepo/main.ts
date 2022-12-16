import { getConfig, packageRegister } from "./repoConfig.js";
import { format } from "node:util";
import coreUtils from "@sirherobrine23/coreutils";
import * as ghcr from "../githubGhcr.js";
import * as release from "../githubRelease.js";

export default async function main(configPath: string) {
  const config = await getConfig(configPath);
  const packageReg = new packageRegister();
  Promise.all(config.repos.map(async repo => {
    if (repo.from === "release") {
      return release.fullConfig({config: repo.repo, githubToken: repo?.auth?.password}, packageReg);
    } else if (repo.from === "oci") {
      return ghcr.list(typeof repo.repo === "string" ? repo.repo : coreUtils.DockerRegistry.Utils.toManifestOptions(format("%s/%s", repo.repo.owner, repo.repo.repo)), repo.ociConfig);
    }
    release.fullConfig({config: repo.repo, githubToken: repo?.auth?.password}, packageReg);
    return ghcr.list(typeof repo.repo === "string" ? repo.repo : coreUtils.DockerRegistry.Utils.toManifestOptions(format("%s/%s", repo.repo.owner, repo.repo.repo)), repo.ociConfig);
  })).catch(console.error);
  return packageReg;
}