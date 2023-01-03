import coreUtils, { DockerRegistry, extendFs, extendsCrypto } from "@sirherobrine23/coreutils";
import { Compressor as lzmaCompressor } from "lzma-native";
import { Readable, Writable } from "node:stream";
import { debianControl } from "@sirherobrine23/coreutils/src/deb.js";
import { createGzip } from "node:zlib";
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
    }
  },
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
  fixedConfig["apt-config"] = {};
  if (configData["apt-config"]) {
    const rootData = configData["apt-config"];
    fixedConfig["apt-config"].portListen = rootData.portListen ?? 3000;
    fixedConfig["apt-config"].poolPath = rootData.poolPath ?? path.join(process.cwd(), "apt-stream");
    fixedConfig["apt-config"].saveFiles = rootData.saveFiles ?? false;
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
  }
  if (fixedConfig["apt-config"].pgpKey) {
    const pgpKey = fixedConfig["apt-config"].pgpKey;
    if (!pgpKey.private.startsWith("---")) fixedConfig["apt-config"].pgpKey.private = await fs.readFile(path.resolve(path.dirname(filePath), pgpKey.private), "utf8");
    if (!pgpKey.public.startsWith("---")) fixedConfig["apt-config"].pgpKey.public = await fs.readFile(path.resolve(path.dirname(filePath), pgpKey.public), "utf8");
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

export type packageData = {
  control: debianControl,
  getStream: () => Readable|Promise<Readable>,
  repositoryConfig?: repository
}

type distObject = {
  [distribuition: string]: {
    [suite: string]: {
      [arch: string]: packageData[]
    }
  }
}

export class distManegerPackages {
  public distribuitions: distObject = {};
  public addDistribuition(distribuition: string) {
    if (!this.distribuitions[distribuition]) this.distribuitions[distribuition] = {};
    return this.distribuitions[distribuition];
  }
  public addSuite(distribuition: string, suite: string) {
    if (!this.distribuitions[distribuition][suite]) this.distribuitions[distribuition][suite] = {};
    return this.distribuitions[distribuition][suite];
  }
  public addArch(distribuition: string, suite: string, arch: string) {
    if (!this.distribuitions[distribuition][suite][arch]) this.distribuitions[distribuition][suite][arch] = [];
    return this.distribuitions[distribuition][suite][arch];
  }

  /**
   * Register package in distribuition and suite
   *
   * @param distribuition
   * @param suite
   * @param arch
   * @param control
   * @param getStream
   * @returns
   */
  public addPackage(distribuition: string, suite: string, packageData: packageData) {
    this.addDistribuition(distribuition);
    this.addSuite(distribuition, suite);
    this.addArch(distribuition, suite, packageData.control.Architecture);
    const currentPackages = this.distribuitions[distribuition][suite][packageData.control.Architecture];
    if (currentPackages.some(pkg => pkg.control.Package === packageData.control.Package)) {
      if (currentPackages.some(pkg => pkg.control.Version === packageData.control.Version && pkg.control.Package === packageData.control.Package)) {
        const index = currentPackages.findIndex(pkg => pkg.control.Version === packageData.control.Version && pkg.control.Package === packageData.control.Package);
        console.info("[INFO]: Replace %s, with version %s, target arch %s, index number %f", packageData.control.Package, packageData.control.Version, packageData.control.Architecture, index);
        return this.distribuitions[distribuition][suite][packageData.control.Architecture][index] = packageData;
      }
    }
    console.info("[INFO]: Add %s, with version %s, target arch %s", packageData.control.Package, packageData.control.Version, packageData.control.Architecture);
    this.distribuitions[distribuition][suite][packageData.control.Architecture].push(packageData);
    return packageData;
  }

  public deletePackage(distribuition: string, suite: string, arch: string, packageName: string, version: string) {
    if (!this.distribuitions[distribuition]) throw new Error("Distribuition not exists");
    if (!this.distribuitions[distribuition][suite]) throw new Error("Suite not exists");
    if (!this.distribuitions[distribuition][suite][arch]) throw new Error("Arch not exists");
    const index = this.distribuitions[distribuition][suite][arch].findIndex(pkg => pkg.control.Package === packageName && pkg.control.Version === version);
    if (index === -1) throw new Error("Package not exists");
    const data = this.distribuitions[distribuition][suite][arch][index];
    this.distribuitions[distribuition][suite][arch].splice(index, 1);
    return data;
  }

  public getAllDistribuitions() {
    return Object.keys(this.distribuitions).map(dist => this.getDistribuition(dist));
  }

  public getDistribuition(dist: string) {
    if (!this.distribuitions[dist]) throw new Error("Distribuition not exists");
    const suitesName = Object.keys(this.distribuitions[dist]);
    const suite = suitesName.map(suite => {
      const archs = Object.keys(this.distribuitions[dist][suite]);
      const archsPackages: {[arch: string]: debianControl[]} = {};
      archs.forEach(arch => archsPackages[arch] = this.distribuitions[dist][suite][arch].map(pkg => pkg.control));
      return {
        suite,
        archs,
        archsPackages
      };
    });
    return {
      distribuition: dist,
      suitesName,
      archs: [...new Set(suite.flatMap(pkg => pkg.archs))],
      suite
    };
  }

  public getPackageInfo(dist: string, suite?: string, arch?: string, packageName?: string, version?: string) {
    const distData = this.distribuitions[dist];
    if (!distData) throw new Error("Distribuition not exists");
    if (!suite) return Object.keys(distData);

    const suiteData = distData[suite];
    if (!suiteData) throw new Error("Suite not exists");
    if (!arch) return Object.keys(suiteData);

    const archData = suiteData[arch];
    if (!archData) throw new Error("Arch not exists");
    if (!packageName) return archData.map(({control, getStream}) => ({control, getStream}));

    const packageData = archData.filter(pkg => pkg.control.Package === packageName);
    if (packageData.length === 0) throw new Error("Package not exists");
    if (!version) return packageData.map(({control, getStream}) => ({control, getStream}));

    const packageVersionData = packageData.find(pkg => pkg.control.Version === version);
    if (!packageVersionData) throw new Error("Package version not exists");
    return packageVersionData.control;
  }

  public async getPackageStream(distribuition: string, suite: string, arch: string, packageName: string, version: string) {
    if (!this.distribuitions[distribuition]) throw new Error("Distribuition not exists");
    if (!this.distribuitions[distribuition][suite]) throw new Error("Suite not exists");
    if (!this.distribuitions[distribuition][suite][arch]) throw new Error("Arch not exists");
    const packageData = this.distribuitions[distribuition][suite][arch].find(pkg => pkg.control.Package === packageName && pkg.control.Version === version);
    if (!packageData) throw new Error("Package not exists");
    return Promise.resolve(packageData.getStream()).then(stream => ({control: packageData.control, repository: packageData.repositoryConfig, stream}));
  }

  public async createPackages(options?: {compress?: "gzip" | "xz", writeStream?: Writable, singlePackages?: boolean, dist?: string, package?: string, arch?: string, suite?: string}) {
    const distribuition = this.distribuitions;
    const rawWrite = new Readable({read(){}});
    let size = 0, addbreak = false, hash: ReturnType<typeof extendsCrypto.createHashAsync>|undefined;
    if (options?.compress === "gzip") {
      const gzip = rawWrite.pipe(createGzip({level: 9}));
      if (options?.writeStream) gzip.pipe(options.writeStream);
      hash = extendsCrypto.createHashAsync("all", gzip);
      gzip.on("data", (chunk) => size += chunk.length);
    } else if (options?.compress === "xz") {
      const lzma = rawWrite.pipe(lzmaCompressor());
      if (options?.writeStream) lzma.pipe(options.writeStream);
      hash = extendsCrypto.createHashAsync("all", lzma);
      lzma.on("data", (chunk) => size += chunk.length);
    } else {
      if (options?.writeStream) rawWrite.pipe(options.writeStream);
      hash = extendsCrypto.createHashAsync("all", rawWrite);
      rawWrite.on("data", (chunk) => size += chunk.length);
    }

    for (const dist in distribuition) {
      if (options?.dist && options.dist !== dist) continue;
      const suites = distribuition[dist];
      for (const suite in suites) {
        if (options?.suite && options.suite !== suite) continue;
        const archs = suites[suite];
        for (const arch in archs) {
          if (arch !== "all" && (options?.arch && options.arch !== arch)) continue;
          const packages = archs[arch];
          for (const {control} of packages) {
            if (!control.Size) continue;
            if (!(control.SHA1 || control.SHA256 || control.MD5sum)) continue;
            if (options?.package && options.package !== control.Package) continue;
            if (addbreak) rawWrite.push("\n\n"); else addbreak = true;
            control["Filename"] = `pool/${dist}/${suite}/${control.Package}/${arch}/${control.Version}/download.deb`;
            const Data = Object.keys(control).map(key => `${key}: ${control[key]}`);
            rawWrite.push(Data.join("\n"));
            if (options?.singlePackages) break;
          }
        }
      }
    }

    rawWrite.push(null);
    if (hash) return hash.then(hash => ({...hash, size}));
    return null;
  }
}