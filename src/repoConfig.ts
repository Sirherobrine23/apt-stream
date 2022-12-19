import coreUtils, { DockerRegistry } from "@sirherobrine23/coreutils";
import * as yaml from "yaml";
import fs from "node:fs/promises";

export type apt_config = {
  origin?: string,
  label?: string,
  enableHash?: boolean,
  sourcesList?: string
};

export type repository = ({
  from: "oci",
  image: string,
  platfom_target?: DockerRegistry.Manifest.platfomTarget
  auth?: {
    username?: string,
    password?: string
  },
  "apt-config"?: apt_config,
}|{
  from: "github_release",
  repository: string,
  owner?: string,
  tags?: string[],
  takeUpTo?: number,
  token?: string,
  "apt-config"?: apt_config,
}) & {
  /** cron range: https://github.com/kelektiv/node-cron#cron-ranges */
  cronRefresh?: string[],
}

export type backendConfig = Partial<{
  "apt-config"?: apt_config,
  repositories: repository[]
}>;

export async function getConfig(filePath: string) {
  if (!await coreUtils.extendFs.exists(filePath)) throw new Error("config File not exists");
  const fixedConfig: backendConfig = {};
  const configData: backendConfig = yaml.parse(await fs.readFile(filePath, "utf8"));
  fixedConfig["apt-config"] = configData["apt-config"] ?? {enableHash: true, label: "apt-stream"};
  fixedConfig.repositories = configData.repositories ?? [];
  fixedConfig.repositories = (fixedConfig.repositories ?? []).map((repo) => {
    if (repo.from === "oci") {
      if (!repo.image) throw new Error("oci repository must have image field");
      const repoFix: repository = {from: "oci", image: repo.image};
      if (repo.platfom_target) repoFix.platfom_target = repo.platfom_target;
      if (repo.auth) repoFix.auth = repo.auth;
      if (repo["apt-config"]) repoFix["apt-config"] = repo["apt-config"];
      if (repo.cronRefresh) repoFix.cronRefresh = repo.cronRefresh;
      return repoFix;
    } else if (repo.from === "github_release") {
      if (!repo.repository) throw new Error("github_release repository must have repository field");
      else if (typeof repo.repository !== "string") throw new Error("github_release repository must be string");
      const repoFix: repository = {from: "github_release", repository: repo.repository};
      if (repo.owner) repoFix.owner = repo.owner;
      else {
        const [owner, ...repository] = repo.repository.split("/");
        if (!owner) throw new Error("github_release repository must have owner field");
        if (repository.length === 0) throw new Error("github_release repository must have repository field");
        repoFix.owner = owner;
        repoFix.repository = repository.join("/");
      }
      if (repo.token) repoFix.token = repo.token;
      if (repo["apt-config"]) repoFix["apt-config"] = repo["apt-config"];
      if (repo.cronRefresh) repoFix.cronRefresh = repo.cronRefresh;
      return repoFix;
    }

    return null;
  }).filter(a => !!a);
  return fixedConfig;
}
