import coreUtils, { DockerRegistry } from "@sirherobrine23/coreutils";
import { promises as fs } from "node:fs";
import { format } from "node:util";
import openpgp from "openpgp";
import path from "node:path";
import yaml from "yaml";

export type repositoryFrom = ({
  type: "mirror",
  url: string,
  dists: {
    [distName: string]: {
      components?: string[],
      archs?: string[],
    }
  }
}|{
  type: "local",
  path: string,
}|{
  type: "http",
  url: string,
  auth?: {
    header?: {[key: string]: string},
    query?: {[key: string]: string}
  }
}|{
  type: "github",
  owner: string,
  repository: string,
  token?: string,
}&({
  subType: "release",
  tag?: string[],
}|{
  subType: "branch",
  branch: string,
})|{
  type: "docker",
  image: string,
  platformConfig?: DockerRegistry.Manifest.platfomTarget
}|{
  type: "google_driver",
  id?: string[],
  app: {
    secret: string,
    id: string,
    token?: string,
  }
}|{
  type: "oracle_bucket",
  region: string,
  bucket: string,
  namespace: string,
  auth: any,
  path?: string[],
}) & {
  componentName?: string,
};

export type aptSConfig = {
  server: {
    /** HTTP Server port listen */
    portListen?: number,
    /** HTTPS Server port listen */
    httpsPortListen?: {
      port: number,
      key: string,
      cert: string
    },
    /** Run http server in cluster mode to many requests */
    cluster?: number,
    /** Enable repository sign with pgp/gpg keys. */
    pgp?: {
      /** Private key, internal not public access */
      privateKey: string,
      /**
       * Public key, to import to user import and save in /etc/apt/trusted.gpg.d/$NAME.gpg
       *
       * @example `curl -L apt.sirherobrine23.org/public.key | gpg --dearmor --yes -o - | sudo tee /etc/apt/trusted.gpg.d/apt.sirherobrine23.org.gpg > /dev/null`
       */
      publicKey: string,
      /** PGP key passphrase */
      passphrase?: string,
      // Key path save dont to final file
      privateKeySave?: string,
      publicKeySave?: string,
    },
  },
  /** Save packages loaded to database to not reload data on start */
  db?: {
    type: "mongodb",
    /** MongoDB Url with mongodb:// or mongodb+srv:// protocoll */
    url: string,
    /** Database name */
    db?: string,
    /** Collection name */
    collection?: string,
  }|{
    type: "couchdb",
    /** URL */
    url: string,
    /**
     * Database name
     *
     * @default 'apt-stream'
     */
    dbName?: string,
  },
  globalAptConfig?: {
    /** Repository origim */
    Origin?: string,
    /** Repository host, example: apt.sirherobrine23.org */
    urlHost?: string,
    /**
     * Old style packages (one package and version per arch)
     *
     * @deprecated Dont use to new apt versions repositorys
     * @default false
     */
    oldPackagesStyles?: boolean
  },
  /**
   * Packages origim and apt structure
   */
  repositorys: {
    [distName: string]: {
      /** Repository soucers array */
      from: repositoryFrom[],
      /**
       * Set Distribution info to extends globalAptConfig
       */
      aptConfig?: {
        /** Replace globalAptConfig origim if seted */
        Origin?: string,
        /** Repository lebel */
        Label?: string,
        /** Repository Codename */
        Codename?: string,
        /** Repository Version (Ubuntu) */
        Version?: string,
        /** Repository description (single line) */
        Description?: string,
        /** Enable (In)Release hash files */
        enableHashes?: boolean,
      }
    }
  }
};

export async function saveConfig(config: aptSConfig|Partial<aptSConfig>, file: string) {
  if (!config) throw new TypeError("config is not defined");
  if (!file) throw new TypeError("file is not defined");
  config = await configManeger(config);
  if (config.server?.pgp) {
    const { privateKeySave, publicKeySave } = config.server.pgp;
    if (privateKeySave) {
      await fs.writeFile(privateKeySave, config.server.pgp.privateKey);
      delete config.server.pgp.privateKeySave;
      config.server.pgp.privateKey = privateKeySave;
    }
    if (publicKeySave) {
      await fs.writeFile(publicKeySave, config.server.pgp.publicKey);
      delete config.server.pgp.publicKeySave;
      config.server.pgp.publicKey = publicKeySave;
    }
  }

  await fs.writeFile(file, path.extname(file) === ".json" ? JSON.stringify(config, null, 2) : yaml.stringify(config));
}

export default configManeger;
export async function configManeger(config?: string|Partial<aptSConfig>) {
  if (!config) throw new TypeError("config is not defined");
  let configData: Partial<aptSConfig>;
  if (typeof config === "string") {
    if (config.startsWith("http")) {
      let remoteConfig = await coreUtils.httpRequest.bufferFetch(config);
      try {
        configData = yaml.parse(remoteConfig.toString());
      } catch {
        try {
          configData = JSON.parse(remoteConfig.toString());
        } catch {
          throw new Error(format("%s is not a valid config file", config));
        }
      }
    } else if (config?.startsWith("env:")||config?.slice(0, 10).trim().toLowerCase().startsWith("base64:")) {
      if (config.startsWith("env:")) {
        if (!process.env[config.slice(4)]?.trim()) throw new TypeError(format("env:%s is not defined", config));
        config = process.env[config.slice(4)]?.trim();
      }
      if (config.slice(0, 10).trim().toLowerCase().startsWith("base64:")) config = Buffer.from(config.slice(8), "base64").toString();
      try {
        configData = yaml.parse(config);
      } catch {
        try {
          configData = JSON.parse(config);
        } catch {
          throw new Error("Unknow config");
        }
      }
    } else if (await coreUtils.extendFs.exists(config)) {
      if (await coreUtils.extendFs.isDirectory(config)) {
        const file = (await fs.readdir(config)).find(file => /(\.)?apt(s)?(_)?(stream)?\.(json|ya?ml)$/i.test(file));
        if (!file) throw new Error(format("Cannot find config file in %O", config));
        config = path.join(config, file);
      }
      const fixedInternal: string = config;
      const localFile = await fs.readFile(fixedInternal, "utf8");
      try {
        configData = yaml.parse(localFile);
      } catch {
        try {
          configData = JSON.parse(localFile);
        } catch {
          throw new Error("Unknow config file");
        }
      }
    } else throw new Error(format("%s not supported load", config));
  } else configData = config;
  if (!configData) throw new Error("configData is not defined");
  if (!configData.repositorys) configData.repositorys = {};
  const partialConfig: Partial<aptSConfig> = {};

  // Server config
  partialConfig.server = {};
  if (configData.server?.portListen) partialConfig.server.portListen = Number(configData.server.portListen);
  if (configData.server?.cluster) partialConfig.server.cluster = Number(configData.server.cluster);
  if (configData.server?.pgp) {
    const pgp = configData.server.pgp;
    if (pgp.publicKey?.trim() && pgp.privateKey?.trim()) {
      if (await coreUtils.extendFs.exists(pgp.publicKey)) {
        pgp.publicKeySave = path.resolve(pgp.publicKey);
        pgp.publicKey = await fs.readFile(pgp.publicKey, "utf8");
      }
      if (await coreUtils.extendFs.exists(pgp.privateKey)) {
        pgp.privateKeySave = path.resolve(pgp.privateKey);
        pgp.privateKey = await fs.readFile(pgp.privateKey, "utf8");
      }
      partialConfig.server.pgp = {
        publicKey: pgp.publicKey,
        privateKey: pgp.privateKey,
        passphrase: pgp.passphrase,
      };
      if (pgp.privateKeySave) partialConfig.server.pgp.privateKeySave = pgp.privateKeySave;
      if (pgp.publicKeySave) partialConfig.server.pgp.publicKeySave = pgp.publicKeySave;
    }
  }

  // Global config
  if (configData.globalAptConfig) {
    partialConfig.globalAptConfig = {
      oldPackagesStyles: configData.globalAptConfig.oldPackagesStyles ?? false,
      Origin: configData.globalAptConfig.Origin,
      urlHost: configData.globalAptConfig.urlHost,
    };
    if (!partialConfig.globalAptConfig.urlHost) delete partialConfig.globalAptConfig.urlHost;
    if (configData.globalAptConfig.Origin === undefined) delete partialConfig.globalAptConfig.Origin;
  }

  // DB config
  if (configData.db) {
    const db = configData.db;
    if (db.type === "mongodb") {
      if (!db.url) throw new TypeError("db.url is not defined");
      const collection = db.collection?.trim() || "apt-stream";
      const database = db.db?.trim() || "apt-stream";
      partialConfig.db = {
        type: "mongodb",
        url: db.url,
        db: database,
        collection,
      };
    } else if (db.type === "couchdb") {
      if (!db.url) throw new TypeError("db.url is not defined");
      const database = String(db.dbName?.trim() || "apt-stream");
      partialConfig.db = {
        type: "couchdb",
        url: db.url,
        dbName: database,
      };
    }
  }

  // Repository config
  partialConfig.repositorys = {};
  for (const distName in configData.repositorys) {
    const dist = configData.repositorys[distName];
    const fixedDist: aptSConfig["repositorys"][string] = {
      aptConfig: {
        enableHashes: dist?.aptConfig?.enableHashes ?? true,
        Label: dist?.aptConfig?.Label,
        Origin: dist?.aptConfig?.Origin,
        Version: dist?.aptConfig?.Version,
        Description: dist?.aptConfig?.Description,
      },
      from: [],
    };
    if (!dist.from) throw new TypeError(format("repositorys.%s.from is not defined", distName));
    for (const from of dist.from) {
      if (typeof from.type !== "string") throw new TypeError(format("repositorys.%s.from.type is not defined", distName));
      if (from.type === "local") {
        if (!from.path) throw new TypeError(format("repositorys.%s.from.path is not defined", distName));
        if (!await coreUtils.extendFs.exists(from.path)) throw new Error(format("repositorys.%s.from.path %s not exists", distName, from.path));
        fixedDist.from.push({
          type: "local",
          componentName: from.componentName,
          path: from.path,
        });
      } else if (from.type === "http") {
        if (!from.url) throw new TypeError(format("repositorys.%s.from.url is not defined", distName));
        fixedDist.from.push({
          type: "http",
          componentName: from.componentName,
          url: from.url,
          auth: from.auth,
        });
      } else if (from.type === "github") {
        if (!(from.owner && from.repository)) throw new TypeError(format("repositorys.%s.from.owner and repositorys.%s.from.repo is not defined", distName, distName));
        if (from.subType === "release") {
          fixedDist.from.push({
            type: "github",
            subType: "release",
            componentName: from.componentName,
            owner: from.owner,
            repository: from.repository,
            tag: from.tag ?? [],
          });
        } else if (from.subType === "branch") {
          fixedDist.from.push({
            type: "github",
            subType: "branch",
            componentName: from.componentName,
            owner: from.owner,
            repository: from.repository,
            branch: from.branch,
          });
        }
      } else if (from.type === "google_driver") {
        if (!(from.app && (from.app?.id && from.app?.secret))) throw new TypeError(format("repositorys.%s.from.app and repositorys.%s.from.fileId is not defined", distName, distName));
        if (!from.id) throw new TypeError(format("repositorys.%s.from.fileId is not defined", distName));
        fixedDist.from.push({
          type: "google_driver",
          componentName: from.componentName,
          app: {
            id: from.app.id,
            secret: from.app.secret,
            token: from.app.token
          },
          id: from.id.filter((id) => typeof id === "string").map((id) => id.trim()),
        });
      } else if (from.type === "oracle_bucket") {
        if (!(from.bucket && from.namespace && from.region)) throw new TypeError(format("repositorys.%s.from.bucket and repositorys.%s.from.region is not defined", distName, distName));
        fixedDist.from.push({
          type: "oracle_bucket",
          componentName: from.componentName,
          bucket: from.bucket,
          namespace: from.namespace,
          region: from.region,
          auth: from.auth,
          path: (from.path ?? []).filter((path) => typeof path === "string").map((path) => path.trim()),
        });
      } else if (from.type === "docker") {
        if (!(from.image)) throw new TypeError(format("repositorys.%s.from.image is not defined", distName));
        fixedDist.from.push({
          type: "docker",
          componentName: from.componentName,
          image: from.image,
          platformConfig: {
            platform: from.platformConfig?.platform,
            arch: from.platformConfig?.arch,
          }
        });
      } else if (from.type === "mirror") {
        if (!(from.url && from.dists)) throw new TypeError(format("repositorys.%s.from.url and repositorys.%s.from.dists is not defined", distName, distName));
        for (const mirroDist in from.dists) {
          if (!from.dists[mirroDist]) throw new TypeError(format("repositorys.%s.from.dists.%s is not defined", distName, mirroDist));
          const dists = from.dists[mirroDist];
          const URLparse = new URL(from.url);
          URLparse.pathname = path.posix.resolve(URLparse.pathname, "dists", mirroDist);
          const inReleaseURL = new URL(URLparse.toString());
          const ReleaseURL = new URL(URLparse.toString());
          inReleaseURL.pathname = path.posix.join(inReleaseURL.pathname, "InRelease");
          ReleaseURL.pathname = path.posix.join(ReleaseURL.pathname, "Release");

          let release = await coreUtils.httpRequest.bufferFetch(inReleaseURL.toString()).catch(() => coreUtils.httpRequest.bufferFetch(ReleaseURL.toString())).then(res => res.data).catch(() => null);
          if (!release) throw new Error(format("repositorys.%s.from.dists.%s can not get Release file", distName, mirroDist));
          if (release.subarray(0, 6).toString().startsWith("----")) release = Buffer.from(((await openpgp.readCleartextMessage({cleartextMessage: release.toString()})).getText()), "utf8");
          const releaseData = await coreUtils.DebianPackage.parseRelease(release);

          if (releaseData.Architectures !== undefined) {
            const archs = releaseData.Architectures as string[];
            if (!dists.archs?.length) dists.archs = archs;
            else dists.archs = dists.archs.filter((arch) => archs.includes(arch));
          }
          if (releaseData.Components !== undefined) {
            const components = releaseData.Components as string[];
            if (!dists.components?.length) dists.components = components;
            else dists.components = dists.components.filter((component) => components.includes(component));
          }

          from.dists[mirroDist] = dists;
        }
        fixedDist.from.push({
          type: "mirror",
          componentName: from.componentName,
          url: from.url,
          dists: from.dists,
        });
      } else throw new TypeError(format("repositorys.%s.from %o is not defined", distName, from));
    }
    partialConfig.repositorys[distName] = fixedDist;
  }

  // GC clean up
  configData = null as any;
  return partialConfig as aptSConfig;
}