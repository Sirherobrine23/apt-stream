import { v2 as dockerRegistry, Auth as dockerAuth, Utils as dockerUtils } from "@sirherobrine23/docker-registry";
import { oracleBucket, googleDriver } from "@sirherobrine23/cloud";
import { aptStreamConfig, repositorySource } from "./config.js";
import { dpkg, apt } from "@sirherobrine23/debian";
import coreHTTP, { Github } from "@sirherobrine23/http";
import mongoDB from "mongodb";
import stream from "node:stream";
import path from "node:path";
import nano from "nano";

export interface dbStorage {
  repositoryID: string;
  restoreFile: any;
  controlFile: dpkg.debianControl;
}

export interface packagesManeger {
  deleteSource(...args: Parameters<(typeof databaseManeger.prototype.deleteSource)>): (void)|Promise<(void)>;
  register(data: dbStorage): void|Promise<void>;
  rawSearch(...args: Parameters<(typeof databaseManeger.prototype.rawSearch)>): (dbStorage[])|Promise<(dbStorage[])>;
  close?(): void|Promise<void>;
};

type RecursivePartial<T> = {
  [P in keyof T]?:
    T[P] extends (infer U)[] ? RecursivePartial<U>[] :
    T[P] extends object ? RecursivePartial<T[P]> :
    T[P];
};

export class databaseManeger {
  #appConfig: aptStreamConfig;
  #internal: packagesManeger;
  constructor(initConfig: aptStreamConfig, func: packagesManeger) {
    this.#appConfig = initConfig;
    this.#internal = func;
  }

  setConfig(config: aptStreamConfig) {
    this.#appConfig = config;
    return this;
  }

  getConfig() {
    return this.#appConfig;
  }

  findRepository(repoID: string) {
    const distName = Object.keys(this.#appConfig.repository).find(distName => this.#appConfig.repository[distName].source.find(src => src.id === repoID));
    if (!distName) throw new Error("Repository name not exsists");
    return distName;
  }


  returnSource(repoID: string) {
    return this.#appConfig.repository[this.findRepository(repoID)].source.find(src => src.id === repoID);
  }

  async close() {
    if (this.#internal.close) await this.#internal.close();
  }

  async returnDistPackages(distName: string) {
    const repo = this.#appConfig.repository[distName];
    if (!repo) throw new Error("This repository not exists");
    const sourcesIDs = repo.source.map(({id}) => id);
    return (await Promise.all(sourcesIDs.map(async id => this.searchPackagesWithID(id)))).flat(2);
  }

  async rawSearch(inDb: Partial<dbStorage>|RecursivePartial<dbStorage>|dbStorage) {
    const data = await this.#internal.rawSearch(inDb);
    return data;
  }

  async searchPackagesWithID(repoID: string): Promise<dbStorage[]> {
    const data = await this.rawSearch({repositoryID: repoID});
    return data;
  }

  async searchPackages(search: dpkg.debianControl|Partial<dpkg.debianControl>): Promise<dbStorage[]> {
    const data = await this.rawSearch({controlFile: search});
    return data;
  }

  async addPackage(repositoryID: string, control: dpkg.debianControl, restore: any): Promise<void> {
    const find = await this.searchPackages({Package: control.Package, Version: control.Version, Architecture: control.Architecture});
    if (find.find((data) => data.repositoryID === repositoryID)) throw new Error("Package is already registered");
    const insert: dbStorage = {repositoryID, restoreFile: restore, controlFile: control};
    return this.#internal.register(insert);
  }

  async deleteSource(repositoryID: string) {
    await this.#internal.deleteSource(repositoryID);
  }

  async getPackageFile(packageTarget: dbStorage): Promise<stream.Readable> {
    const source = this.#appConfig.repository[this.findRepository(packageTarget.repositoryID)].source.find(s => s.id === packageTarget.repositoryID);
    if (!source) throw new Error("Package Source no more avaible please sync packages!");
    if (source.type === "http") {
      const { url, auth: { header: headers, query } } = source;
      return coreHTTP.streamRequest(url, {headers, query});
    } else if (source.type === "mirror") {
      const { debUrl } = packageTarget.restoreFile;
      return coreHTTP.streamRequest(debUrl);
    } else if (source.type === "github") {
      const { token } = source, { url } = packageTarget.restoreFile;
      return coreHTTP.streamRequest(url, {headers: token ? {"Authorization": "token "+token} : {}});
    } else if (source.type === "oracle_bucket") {
      const { authConfig } = source, { restoreFile: { path } } = packageTarget;
      const bucket = await oracleBucket.oracleBucket(authConfig);
      return bucket.getFileStream(path);
    } else if (source.type === "google_driver") {
      const { clientId, clientSecret, clientToken } = source, { restoreFile: { id } } = packageTarget;
      const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
      return gdrive.getFileStream(id);
    } else if (source.type === "docker") {
      const { image, auth } = source, { ref, path: debPath } = packageTarget.restoreFile;
      const registry = new dockerRegistry(image, auth);
      return new Promise<stream.Readable>((done, reject) => registry.extractLayer(ref).then(tar => tar.on("error", reject).on("File", entry => entry.path === debPath ? done(entry.stream) : null)));
    }
    throw new Error("Check package type");
  }

  async registerSource(target: repositorySource, callback?: (control: dpkg.debianControl) => void) {
    const { id } = target;
    if (target.type === "http") {
      const control = await dpkg.parsePackage(await coreHTTP.streamRequest(target.url, {headers: target.auth?.header, query: target.auth?.query}));
      await this.addPackage(id, control, {}).then(() => typeof callback === "function" ? callback(control) : null);
    } else if (target.type === "oracle_bucket") {
      const { authConfig, path = [] } = target;
      const bucket = await oracleBucket.oracleBucket(authConfig);
      if (path.length === 0) path.push(...((await bucket.listFiles()).filter(k => k.name.endsWith(".deb")).map(({name}) => name)));
      for (const file of path) {
        const control = await dpkg.parsePackage(await bucket.getFileStream(file));
        await this.addPackage(id, control, {path: file}).then(() => typeof callback === "function" ? callback(control) : null);
      }
    } else if (target.type === "google_driver") {
      const { clientId, clientSecret, clientToken, gIds = [] } = target;
      if (!clientToken) throw new Error(`Cannot get files from ${id}, Google driver token is blank`);
      const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
      if (gIds.length === 0) gIds.push(...((await gdrive.listFiles()).filter(rel => rel.name.endsWith(".deb")).map(({id}) => id)));
      for (const file of gIds) {
        const control = await dpkg.parsePackage(await gdrive.getFileStream(file));
        await this.addPackage(id, control, {id: file}).then(() => typeof callback === "function" ? callback(control) : null);
      }
    } else if (target.type === "github") {
      const { owner, repository, token } = target;
      const gh = await Github.GithubManeger(owner, repository, token);
      if (target.subType === "branch") {
        const { branch = (await gh.branchList()).at(0)?.name ?? "main" } = target;
        for (const { path: filePath } of (await gh.trees(branch)).tree.filter(file => file.type === "tree" ? false : file.path.endsWith(".deb"))) {
          const rawURL = new URL(path.posix.join(owner, repository, branch, filePath), "https://raw.githubusercontent.com");
          const control = await dpkg.parsePackage(await coreHTTP.streamRequest(rawURL, {headers: token ? {Authorization: `token ${token}`} : {}}));
          await this.addPackage(id, control, {url: rawURL.toString()}).then(() => typeof callback === "function" ? callback(control) : null);
        }
      } else {
        const { tag = [] } = target;
        for (const tagName of tag) {
          const assets = (await gh.getRelease(tagName)).assets.filter(({name}) => name.endsWith(".deb"));
          for (const asset of assets) {
            const control = await dpkg.parsePackage(await coreHTTP.streamRequest(asset.browser_download_url, {headers: token ? {Authorization: `token ${token}`} : {}}));
            await this.addPackage(id, control, {url: asset.browser_download_url}).then(() => typeof callback === "function" ? callback(control) : null);
          }
        }
      }
    } else if (target.type === "docker") {
      const { image, auth, tags = [] } = target;
      const registry = new dockerRegistry(image, auth);
      const userAuth = new dockerAuth(registry.image, "pull", auth);
      if (tags.length === 0) {
        const { sha256, tag } = registry.image;
        if (sha256) tags.push(sha256);
        else if (tag) tags.push(tag);
        else tags.push(...((await registry.getTags()).reverse().slice(0, 6)));
      }
      await userAuth.setup();
      for (const tag of tags) {
        const manifestManeger = new dockerUtils.Manifest(await registry.getManifets(tag, userAuth), registry);
        const addPckage = async () => {
          for (const layer of manifestManeger.getLayers()) {
            const blob = await registry.extractLayer(layer.digest, userAuth);
            blob.on("File", async entry => {
              if (!(entry.path.endsWith(".deb"))) return null;
              const control = await dpkg.parsePackage(entry.stream);
              await this.addPackage(id, control, {ref: layer.digest, path: entry.path}).then(() => typeof callback === "function" ? callback(control) : null);
            });
            await new Promise<void>((done, reject) => blob.on("close", done).on("error", reject));
          }
        }
        if (manifestManeger.multiArch) {
          for (const platform of manifestManeger.platforms) {
            await manifestManeger.setPlatform(platform as any);
            await addPckage();
          }
        } else await addPckage();
      }
    } else if (target.type === "mirror") {
      const { config } = target;
      const at = apt.getRepoPackages(config).on("package", async (repoUrl, _distname, _componentName, _arch, data) => {
        const debUrl = new URL(repoUrl);
        debUrl.pathname = path.posix.join(debUrl.pathname, data.Filename);
        const control = await dpkg.parsePackage(await coreHTTP.streamRequest(debUrl));
        await this.addPackage(id, control, {debUrl: debUrl.toString()}).then(() => typeof callback === "function" ? callback(control) : null);
      }).on("error", console.error);
      await new Promise<void>(done => at.on("close", () => done()));
    }
  }
}

export async function databaseManegerSetup(config: aptStreamConfig) {
  const { database } = config;
  if (!database) throw new Error("Setup database");
  if (database.drive === "mongodb") {
    const mongoClient = await (new mongoDB.MongoClient(database.url)).connect();
    mongoClient.on("error", err => console.error(err));
    const collection = mongoClient.db(database.databaseName ?? "apt-stream").collection<dbStorage>(database.collection ?? "packages");
    return new databaseManeger(config, {
      async close() {await mongoClient.close();},
      async register(data) {await collection.insertOne(data);},
      async rawSearch(search) {return collection.find(search).toArray();},
      async deleteSource(repositoryID) {
        await collection.deleteMany(await (collection.find({repositoryID}).toArray()));
      },
    });
  } else if (database.drive === "couchdb") {
    const nanoClient = nano(database.url);
    if (!((await nanoClient.session()).ok)) throw new Error("Invalid auth or Fail to auth in database");
    const nanoDb = nanoClient.db.use<dbStorage>(database.databaseName ?? "aptStream");
    return new databaseManeger(config, {
      async register(data) {
        await nanoDb.insert(data);
      },
      async rawSearch(search) {
        return (await nanoDb.find({selector: {...search}})).docs;
      },
      async deleteSource(repositoryID) {
        const docs = (await nanoDb.find({selector: {repositoryID}})).docs;
        await Promise.all(docs.map(async ({_id, _rev}) => nanoDb.destroy(_id, _rev)));
      },
    });
  }
  throw new Error("Invalid drive config");
}