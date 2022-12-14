import * as configManeger from "./repoConfig.js";
import * as ghcr from "./githubGhcr.js";
import * as release from "./githubRelease.js";

const config = await configManeger.getConfig("./repoconfig.yml");
await Promise.all(config.repos.map(async repoConfig => {
  if (repoConfig.from === "release") return release.localRepo(repoConfig.repo);
  else if (repoConfig.from === "oci") return ghcr.localRepo(typeof repoConfig.repo === "string" ? repoConfig.repo : `${repoConfig.repo.owner}/${repoConfig.repo.repo}`);
  const releaseLocal = await release.localRepo(repoConfig.repo);
  const ociLocal = await ghcr.localRepo(typeof repoConfig.repo === "string" ? repoConfig.repo : `${repoConfig.repo.owner}/${repoConfig.repo.repo}`);
  return {
    releaseLocal,
    ociLocal
  };
}));