import coreUtils from "@sirherobrine23/coreutils";
import { format } from "util";
import * as ghcr from "./githubGhcr.js";
import * as release from "./githubRelease.js";
import { getConfig } from "./repoConfig.js";

export default async function main(configPath: string) {
  const config = await getConfig(configPath);
  return Promise.all(config.repos.map(async repo => {
    if (repo.from === "release") return {repo: repo.repo, is: repo.from, release: await release.list(repo.repo, repo?.auth?.password)};
    else if (repo.from === "oci") return {repo: repo.repo, is: repo.from, oci: await ghcr.list(typeof repo.repo === "string" ? repo.repo : coreUtils.DockerRegistry.Utils.toManifestOptions(format("%s/%s", repo.repo.owner, repo.repo.repo)), repo.ociConfig)}
    return {
      repo: repo.repo,
      is: repo.from,
      release: await release.list(repo.repo, repo?.auth?.password),
      oci: await ghcr.list(typeof repo.repo === "string" ? repo.repo : coreUtils.DockerRegistry.Utils.toManifestOptions(format("%s/%s", repo.repo.owner, repo.repo.repo)), repo.ociConfig)
    };
  }));
}