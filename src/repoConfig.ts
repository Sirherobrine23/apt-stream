import coreUtils, { DockerRegistry, extendFs, httpRequest } from "@sirherobrine23/coreutils";
import { format } from "node:util";
import yaml from "yaml";
import path from "node:path";
import fs from "node:fs/promises";

export type apt_config = {
  origin?: string,
  label?: string,
  codename?: string,
  enableHash?: boolean,
  sourcesHost?: string
};

export type repository = ({
  from: "mirror",
  uri: string,
  saveFiles?: string,
  dists: {
    [distribuition: string]: {
      suites: string[],
      archs?: string[]
    }
  }
}|{
  from: "oci",
  image: string,
  platfom_target?: DockerRegistry.Manifest.platfomTarget,
  enableLocalCache?: boolean,
  cachePath?: string,
  auth?: {
    username?: string,
    password?: string
  }
}|{
  from: "github_release",
  repository: string,
  owner?: string,
  tags?: string[],
  assetsLimit?: number,
  token?: string,
}|{
  from: "github_tree",
  repository: string,
  owner?: string,
  tree?: string,
  path?: string[],
  token?: string
}|{
  from: "oracle_bucket",
  bucketName: string,
  bucketNamespace: string,
  region: string,
  auth?: any,
  folders?: string[],
}|{
  from: "google_drive",
  appSettings: {
    client_id: string,
    client_secret: string,
    token?: string
  },
  folderId?: string[],
  watchFolder?: boolean
}) & {
  /** cron range: https://github.com/kelektiv/node-cron#cron-ranges */
  cronRefresh?: string[],
  suite?: string
}

export type backendConfig = Partial<{
  "apt-config"?: apt_config & {
    portListen?: number,
    poolPath?: string,
    saveFiles?: boolean,
    pgpKey?: {
      private: string,
      public: string,
      passphrase?: string
    },
    mongodb?: {
      uri: string,
      db?: string,
      collection?: string,
      /** On connect to database drop collection to run in empty data */
      dropCollention?: boolean
    },
    packagesOptions?: {
      uniqueVersion?: boolean,
    }
  },
  repositories: {
    [distribuition: string]: {
      "apt-config"?: apt_config,
      targets: repository[]
    }
  }
}>;

export function poolLocationPackage(dist: string, suite: string, arch: string, packageName: string, version: string) {
  return format("pool/%s/%s/%s/%s/%s/download.deb", dist, suite, arch, packageName, version);
}

export async function saveConfig(filePath: string, config: backendConfig) {
  await fs.writeFile(filePath, yaml.stringify(config));
}

export async function getConfig(config: string) {
  let configData: backendConfig, avaiableToDirname = true;
  if (config.startsWith("http")) {
    avaiableToDirname = false;
    const data = (await httpRequest.bufferFetch(config)).data;
    try {
      configData = JSON.parse(data.toString());
    } catch {
      try {
        configData = yaml.parse(data.toString());
      } catch {
        throw new Error("Invalid config file");
      }
    }
  } else if (config.startsWith("env:")||config.startsWith("base64:")||config.startsWith("BASE64:")) {
    if (config.startsWith("env:")) config = process.env[config.replace(/^env:/, "")];
    if (/^(base64|BASE64):/.test(config)) config = Buffer.from(config.replace(/^(base64|BASE64):/, ""), "base64").toString();
    avaiableToDirname = false;
    try {
      configData = JSON.parse(config);
    } catch {
      try {
        configData = yaml.parse(config);
      } catch {
        throw new Error("Invalid config file in env, check is JSON or YAML file");
      }
    }
  } else {
    if (!await coreUtils.extendFs.exists(config)) throw new Error("config File not exists, return "+JSON.stringify(config));
    configData = yaml.parse(await fs.readFile(config, "utf8"));
  }
  if (typeof configData !== "object") throw new Error("Invalid config file");

  const fixedConfig: backendConfig = {
    "apt-config": {
      packagesOptions: {
        uniqueVersion: configData["apt-config"]?.packagesOptions?.uniqueVersion ?? false
      }
    },
    repositories: {}
  };
  if (configData["apt-config"]) {
    const rootData = configData["apt-config"];
    fixedConfig["apt-config"].portListen = rootData.portListen ?? 3000;
    fixedConfig["apt-config"].saveFiles = rootData.saveFiles ?? false;
    if (rootData.poolPath) fixedConfig["apt-config"].poolPath = rootData.poolPath;
    if (fixedConfig["apt-config"].poolPath && !await extendFs.exists(fixedConfig["apt-config"].poolPath)) await fs.mkdir(fixedConfig["apt-config"].poolPath, {recursive: true});
    if (rootData.codename) fixedConfig["apt-config"].codename = rootData.codename;
    if (rootData.origin) fixedConfig["apt-config"].origin = rootData.origin;
    if (rootData.label) fixedConfig["apt-config"].label = rootData.label;
    if (rootData.enableHash) fixedConfig["apt-config"].enableHash = rootData.enableHash;
    if (rootData.sourcesHost) fixedConfig["apt-config"].sourcesHost = rootData.sourcesHost;
    if (rootData.pgpKey) {
      if (!(rootData.pgpKey.private && rootData.pgpKey.public)) throw new Error("pgpKey not defined");
      const privateKey = rootData.pgpKey.private.startsWith("---") ? rootData.pgpKey.private : await fs.readFile(path.resolve(rootData.pgpKey.private), "utf8");
      const publicKey = rootData.pgpKey.public.startsWith("---") ? rootData.pgpKey.public : await fs.readFile(path.resolve(rootData.pgpKey.public), "utf8");
      let passphrase = rootData.pgpKey.passphrase;
      if (!passphrase) passphrase = undefined
      fixedConfig["apt-config"].pgpKey = {
        private: privateKey,
        public: publicKey,
        passphrase
      };
    }
    if (rootData.mongodb) {
      if (!rootData.mongodb.uri) throw new Error("mongodb.uri not defined");
      fixedConfig["apt-config"].mongodb = {
        uri: rootData.mongodb.uri,
        db: rootData.mongodb.db ?? "apt-stream",
        collection: rootData.mongodb.collection ?? "packages",
        dropCollention: Boolean(rootData.mongodb.dropCollention ?? false)
      };
    }
  }
  if (fixedConfig["apt-config"].pgpKey) {
    const pgpKey = fixedConfig["apt-config"].pgpKey;

    if (!pgpKey.private.startsWith("---")) {
      if (!avaiableToDirname) throw new Error("Cannot read private key from url or env");
      fixedConfig["apt-config"].pgpKey.private = await fs.readFile(path.resolve(path.dirname(config), pgpKey.private), "utf8");
    }
    if (!pgpKey.public.startsWith("---")) {
      if (!avaiableToDirname) throw new Error("Cannot read public key from url or env");
      fixedConfig["apt-config"].pgpKey.public = await fs.readFile(path.resolve(path.dirname(config), pgpKey.public), "utf8");
    }
  }
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
      if (target.from === "mirror") {
        if (!target.uri) throw new Error("mirror uri not defined");
        const mirrorData: repository = {from: "mirror", uri: target.uri, dists: {}};
        if (target.dists) {
          Object.keys(target.dists).forEach(distribuition => {
            const distribuitionConfig = target.dists[distribuition];
            if (!distribuitionConfig) return;
            mirrorData.dists[distribuition] = {suites: []};
            if (distribuitionConfig.suites) mirrorData.dists[distribuition].suites = distribuitionConfig.suites;
            if (distribuitionConfig.archs) mirrorData.dists[distribuition].archs = distribuitionConfig.archs;
          });
        }
        fixedConfig.repositories[distribuition].targets.push({
          ...mirrorData,
          suite: target.suite ?? "main"
        });
      } else if (target.from === "oci") {
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
        if (target.assetsLimit) githubData.assetsLimit = target.assetsLimit;
        if (target.cronRefresh) githubData.cronRefresh = target.cronRefresh;
        fixedConfig.repositories[distribuition].targets.push({
          ...githubData,
          suite: target.suite ?? "main"
        });
      } else if (target.from === "github_tree") {
        if (!target.repository) throw new Error("github_tree repository not defined");
        const githubData: repository = {from: "github_tree", repository: target.repository};
        if (target.owner) githubData.owner = target.owner;
        githubData.tree = target.tree ?? "main";
        if (target.path) githubData.path = target.path;
        if (target.token) githubData.token = target.token;
        if (target.cronRefresh) githubData.cronRefresh = target.cronRefresh;
        fixedConfig.repositories[distribuition].targets.push({
          ...githubData,
          suite: target.suite ?? "main"
        });
      } else if (target.from === "oracle_bucket") {
        if (!(target.bucketName && target.bucketNamespace && target.region)) throw new Error("oracle_bucket bucket not defined");
        const oracleData: repository = {
          from: "oracle_bucket",
          bucketName: target.bucketName,
          bucketNamespace: target.bucketNamespace,
          region: target.region,
        };

        if (target.folders) oracleData.folders = target.folders;
        if (target.auth) oracleData.auth = target.auth;

        if (target.cronRefresh) oracleData.cronRefresh = target.cronRefresh;
        fixedConfig.repositories[distribuition].targets.push({
          ...oracleData,
          suite: target.suite ?? "main"
        });
      } else if (target.from === "google_drive") {
        if (!(target.appSettings?.client_id && target.appSettings?.client_secret)) throw new Error("google_drive appSettings not defined");
        const googleData: repository = {
          from: "google_drive",
          appSettings: {
            client_id: target.appSettings.client_id,
            client_secret: target.appSettings.client_secret,
            token: target.appSettings.token
          },
          folderId: []
        };
        if (target.watchFolder !== undefined) googleData.watchFolder = target.watchFolder;
        if (target.folderId && target.folderId?.length > 0) googleData.folderId = target.folderId;
        if (target.cronRefresh) googleData.cronRefresh = target.cronRefresh;
        fixedConfig.repositories[distribuition].targets.push({
          ...googleData,
          suite: target.suite ?? "main"
        });
      }
    });
  });
  return fixedConfig;
}