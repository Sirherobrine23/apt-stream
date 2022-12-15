import { getConfig, packageRegister } from "./repoConfig.js";
import { format } from "util";
import coreUtils from "@sirherobrine23/coreutils";
import * as ghcr from "../githubGhcr.js";
import * as release from "../githubRelease.js";

export default async function main(configPath: string) {
  const config = await getConfig(configPath);
  const packageReg = new packageRegister();
  Promise.all(config.repos.map(async repo => {
    if (repo.from === "release") {
      await release.list(repo.repo, repo?.auth?.password);
      return;
    } else if (repo.from === "oci") {
      await ghcr.list(typeof repo.repo === "string" ? repo.repo : coreUtils.DockerRegistry.Utils.toManifestOptions(format("%s/%s", repo.repo.owner, repo.repo.repo)), repo.ociConfig);
      return;
    }
    const releaseData = await release.list(repo.repo, repo?.auth?.password), oci = await ghcr.list(typeof repo.repo === "string" ? repo.repo : coreUtils.DockerRegistry.Utils.toManifestOptions(format("%s/%s", repo.repo.owner, repo.repo.repo)), repo.ociConfig);
    console.log(releaseData, oci);
    return;
  })).catch(console.error);
  return packageReg;
}