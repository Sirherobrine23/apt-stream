import coreUtils, { DockerRegistry } from "@sirherobrine23/coreutils";
import * as yaml from "yaml";
import fs from "node:fs/promises";

export type apt_config = {
  origin?: string,
  label?: string,
  codename?: string,
  enableHash?: boolean,
  sourcesHost?: string
};

export type repository = ({
  from: "oci",
  image: string,
  platfom_target?: DockerRegistry.Manifest.platfomTarget,
  enableLocalCache?: boolean,
  auth?: {
    username?: string,
    password?: string
  }
}|{
  from: "github_release",
  repository: string,
  owner?: string,
  tags?: string[],
  takeUpTo?: number,
  token?: string,
}|{
  from: "github_tree",
  repository: string,
  owner?: string,
  path?: string,
  token?: string
}) & {
  /** cron range: https://github.com/kelektiv/node-cron#cron-ranges */
  cronRefresh?: string[],
  suite?: string,
}

export type backendConfig = Partial<{
  "apt-config"?: apt_config & {
    portListen?: number,
    pgpKey?: {
      private: string,
      public: string,
      passphrase?: string
    }
  },
  all?: apt_config,
  repositories: {
    [distribuition: string]: {
      "apt-config"?: apt_config,
      targets: repository[]
    }
  }
}>;

export async function saveConfig(filePath: string, config: backendConfig) {
  await fs.writeFile(filePath, yaml.stringify(config));
}

export async function getConfig(filePath: string) {
  if (!await coreUtils.extendFs.exists(filePath)) throw new Error("config File not exists");
  const fixedConfig: backendConfig = {};
  const configData: backendConfig = yaml.parse(await fs.readFile(filePath, "utf8"));
  fixedConfig["apt-config"] = configData["apt-config"] ?? {enableHash: true, label: "apt-stream"};
  fixedConfig.repositories = {};
  if (!configData.repositories) configData.repositories = {};
  else if (Array.isArray(configData.repositories) && typeof configData.repositories === "object") configData.repositories = {};
  
  Object.keys(configData.repositories).forEach(distribuition => {
    const distribuitionConfig = configData.repositories[distribuition];
    if (!distribuitionConfig) return;
    fixedConfig.repositories[distribuition] = {targets: []};
    fixedConfig.repositories[distribuition]["apt-config"] = distribuitionConfig["apt-config"] ?? {};
    distribuitionConfig.targets.forEach(target => {
      if (!target) return;
      if (target.from === "oci") {
        if (!target.image) throw new Error("oci image not defined");
        const ociData: repository = {from: "oci", image: target.image};
        if (target.auth) ociData.auth = ociData.auth;
        if (target.enableLocalCache) ociData.enableLocalCache = target.enableLocalCache ?? false;
        if (target.cronRefresh) ociData.cronRefresh = target.cronRefresh;
        if (target.platfom_target) ociData.platfom_target = {
          arch: target.platfom_target.arch ?? process.arch,
          platform: target.platfom_target.platform ?? process.platform,
        };
        fixedConfig.repositories[distribuition].targets.push({
          ...ociData,
          suite: target.suite ?? "main"
        });
      } else if (target.from === "github_release") {
        if (!target.repository) throw new Error("github_release repository not defined");
        const githubData: repository = {from: "github_release", repository: target.repository};
        if (target.owner) githubData.owner = target.owner;
        if (target.token) githubData.token = target.token;
        if (target.tags) githubData.tags = target.tags;
        if (target.takeUpTo) githubData.takeUpTo = target.takeUpTo;
        if (target.cronRefresh) githubData.cronRefresh = target.cronRefresh;
        fixedConfig.repositories[distribuition].targets.push({
          ...githubData,
          suite: target.suite ?? "main"
        });
      } else if (target.from === "github_tree") {
        if (!target.repository) throw new Error("github_tree repository not defined");
        const githubData: repository = {from: "github_tree", repository: target.repository};
        if (target.owner) githubData.owner = target.owner;
        if (target.token) githubData.token = target.token;
        if (target.path) githubData.path = target.path;
        if (target.cronRefresh) githubData.cronRefresh = target.cronRefresh;
        fixedConfig.repositories[distribuition].targets.push({
          ...githubData,
          suite: target.suite ?? "main"
        });
      }
    });
  });
  return fixedConfig;
}