import { v2 as dockerRegistry, Auth as dockerAuth, Utils as dockerUtils } from "@sirherobrine23/docker-registry";
import { createReadStream, createWriteStream } from "node:fs";
import { oracleBucket, googleDriver } from "@sirherobrine23/cloud";
import { aptStreamConfig, repositorySource } from "./config.js";
import { dpkg, apt } from "@sirherobrine23/debian";
import { extendsCrypto, extendsFS } from "@sirherobrine23/extends";
import { tmpdir } from "node:os";
import streamPromise from "node:stream/promises";
import decompress, { compress as streamCompress } from "@sirherobrine23/decompress";
import coreHTTP, { Github } from "@sirherobrine23/http";
import oldFs, { promises as fs } from "node:fs";
import mongoDB from "mongodb";
import openpgp from "openpgp";
import stream from "node:stream";
import path from "node:path";
import nano from "nano";

export interface dbStorage {
  repositoryID: string;
  restoreFile: any;
  controlFile: dpkg.debianControl;
}

export interface packagesManeger {
  mongoCollection?: mongoDB.Collection<dbStorage>;
  deleteSource(...args: Parameters<(typeof databaseManeger.prototype.deleteSource)>): (void)|Promise<(void)>;
  register(data: dbStorage): void|Promise<void>;
  rawSearch(...args: Parameters<(typeof databaseManeger.prototype.rawSearch)>): (dbStorage[])|Promise<(dbStorage[])>;
  close?(): void|Promise<void>;
};

type RecursivePartial<T> = {[P in keyof T]?: T[P] extends (infer U)[] ? RecursivePartial<U>[] : T[P] extends object ? RecursivePartial<T[P]> : T[P];};

export class Release {
  constructor() {Object.defineProperty(this, "Date", {writable: false});}
  readonly Date = new Date().toUTCString();
  acquireByHash = false;
  Codename: string;
  Origin: string;
  Label: string;
  Version: string;
  Description: string;
  md5 = new Set<{hash: string, size: number, path: string}>();
  SHA1 = new Set<{hash: string, size: number, path: string}>();
  SHA256 = new Set<{hash: string, size: number, path: string}>();
  SHA512 = new Set<{hash: string, size: number, path: string}>();

  Architectures = new Set<string>();
  getArchs() {return Array.from(this.Architectures.values());}

  Components = new Set<string>();
  getComponents() {return Array.from(this.Components.values());}

  toString() {
    if (this.getArchs().length === 0) throw new Error("Set one Arch");
    if (this.getComponents().length === 0) throw new Error("Set one Component");
    let configString: string[] = [
      "Date: "+(this.Date),
      "Acquire-By-Hash: "+(this.acquireByHash ? "yes" : "no"),
      "Architectures: "+(this.getArchs().join(" ")),
      "Components: "+(this.getComponents().join(" ")),
    ];

    if (this.Codename) configString.push(`Codename: ${this.Codename}`);
    if (this.Origin) configString.push(`Origin: ${this.Origin}`);
    if (this.Label) configString.push(`Label: ${this.Label}`);
    if (this.Version) configString.push(`Version: ${this.Version}`);
    if (this.Description) configString.push(`Description: ${this.Description}`);

    const md5Array = Array.from(this.md5.values()).sort((b, a) => a.size - b.size);
    if (md5Array.length > 0) {
      configString.push("MD5Sum:");
      const sizeLength = md5Array.at(0).size.toString().length+2;
      md5Array.forEach(data => configString.push((" "+data.hash + " "+(Array((sizeLength - (data.size.toString().length))).fill("").join(" ")+(data.size.toString()))+" "+data.path)));
    }

    const sha1Array = Array.from(this.SHA1.values()).sort((b, a) => a.size - b.size);
    if (sha1Array.length > 0) {
      configString.push("SHA1:");
      const sizeLength = sha1Array.at(0).size.toString().length+2;
      sha1Array.forEach(data => configString.push((" "+data.hash + " "+(Array((sizeLength - (data.size.toString().length))).fill("").join(" ")+(data.size.toString()))+" "+data.path)));
    }

    const sha256Array = Array.from(this.SHA256.values()).sort((b, a) => a.size - b.size);
    if (sha256Array.length > 0) {
      configString.push("SHA256:");
      const sizeLength = sha256Array.at(0).size.toString().length+2;
      sha256Array.forEach(data => configString.push((" "+data.hash + " "+(Array((sizeLength - (data.size.toString().length))).fill("").join(" ")+(data.size.toString()))+" "+data.path)));
    }

    const sha512Array = Array.from(this.SHA512.values()).sort((b, a) => a.size - b.size);
    if (sha512Array.length > 0) {
      configString.push("SHA512:");
      const sizeLength = sha512Array.at(0).size.toString().length+2;
      sha512Array.forEach(data => configString.push((" "+data.hash + " "+(Array((sizeLength - (data.size.toString().length))).fill("").join(" ")+(data.size.toString()))+" "+data.path)));
    }

    return configString.join("\n");
  }

  async inRelease(gpgSign: aptStreamConfig["gpgSign"], type: "sign"|"clearMessage" = "sign"): Promise<string> {
    const privateKey = gpgSign.authPassword ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: gpgSign.private.content }), passphrase: gpgSign.authPassword}) : await openpgp.readPrivateKey({ armoredKey: gpgSign.private.content });
    const text = this.toString();
    if (type === "clearMessage") return Buffer.from(await openpgp.sign({
      signingKeys: privateKey,
      format: "armored",
      message: await openpgp.createMessage({text})
    }) as any).toString("utf8");
    return openpgp.sign({signingKeys: privateKey, format: "armored", message: await openpgp.createCleartextMessage({text})});
  }

  toJSON() {
    return {
      Date: this.Date,
      acquireByHash: this.acquireByHash,
      Codename: this.Codename,
      Origin: this.Origin,
      Label: this.Label,
      Version: this.Version,
      Description: this.Description,
      Architectures: Array.from(this.Architectures.values()),
      Components: Array.from(this.Components.values()),
      MD5Sum: Array.from(this.md5.values()),
      SHA1: Array.from(this.SHA1.values()),
      SHA256: Array.from(this.SHA256.values()),
      SHA512: Array.from(this.SHA512.values()),
    };
  }
}

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

  async close() {
    if (this.#internal.close) await this.#internal.close();
  }

  getResouces(): (repositorySource & {repositoryName: string})[] {
    const int = this.#appConfig.repository;
    return Object.keys(int).reduce((acc, keyRepo) => {
      int[keyRepo].source.forEach(data => {
        acc.push({
          repositoryName: keyRepo,
          ...data,
        });
      });
      return acc;
    }, []);
  }

  async rawSearch(inDb: Partial<dbStorage>|RecursivePartial<dbStorage>|mongoDB.Filter<dbStorage>|dbStorage) {
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

  async getUniqData<T = any>(key: any, filter: mongoDB.Filter<dbStorage>): Promise<T[]> {
    if (this.#internal.mongoCollection) return this.#internal.mongoCollection.distinct(key, filter);
    return [];
  }

  async createPackage(repositoryName: string, componentName: string, Arch: string, options?: {compress?: "gz"|"xz", appRoot?: string, callback?: (str: stream.Readable) => void}) {
    const repositorys = this.getResouces().filter(repo => (repo.repositoryName === repositoryName) && ((repo.componentName ?? "main") === componentName));
    if (!repositorys.length) throw new Error("Repository or Component name not exists!");
    const { appRoot = "", callback } = (options ??= {});
    const str = new stream.Readable({read(){}});
    (async () => {
      let breakLine = false;
      for (const repo of repositorys) {
        const componentName = repo.componentName || "main";
        for (const { controlFile: pkg } of await this.rawSearch({repositoryID: repo.id, "controlFile.Architecture": Arch})) {
          let pkgHash: string;
          if (!(pkgHash = pkg.SHA1)) continue;
          if (breakLine) str.push("\n\n"); else breakLine = true;
          str.push(dpkg.createControl({
            ...pkg,
            Filename: path.posix.join("/", appRoot, "pool", componentName, `${pkgHash}.deb`).slice(1),
          }));
        }
      }
      str.push(null);
    })().catch(err => str.emit("error", err));

    const compress = str.pipe(streamCompress(options.compress === "gz" ? "gzip" : options.compress === "xz" ? "xz" : "passThrough"));
    if (typeof callback === "function") (async () => callback(compress))().catch(err => str.emit("error", err));
    return extendsCrypto.createHashAsync(compress).then(({hash, byteLength}) => ({
      filePath: path.posix.join(componentName, "binary-"+Arch, "Packages"+(options.compress === "gz" ? ".gz" : options.compress === "xz" ? ".xz" : "")),
      fileSize: byteLength,
      sha512: hash.sha512,
      sha256: hash.sha256,
      sha1: hash.sha1,
      md5: hash.md5,
    }));
  }

  getRepoReleaseConfig(repositoryName: string) {
    if (!this.#appConfig.repository[repositoryName]) throw new Error("Repository not exists");
    let config = this.#appConfig.repository[repositoryName].aptConfig;
    config ??= {Origin: repositoryName, Label: repositoryName};
    config.Codename ??= repositoryName;
    config.Origin ??= repositoryName;
    config.Label ??= repositoryName;
    return config;
  }

  async createRelease(repositoryName: string, appRoot: string) {
    const relConfig = this.getRepoReleaseConfig(repositoryName);
    const resources = this.getResouces().filter(repo => repo.repositoryName === repositoryName);
    if (!resources.length) throw new Error("no repository with this name");
    const rel = new Release();
    rel.Description = relConfig.Description;
    rel.Codename = relConfig.Codename;
    rel.Version = relConfig.Version;
    rel.Origin = relConfig.Origin;
    rel.Label = relConfig.Label;

    // Add components name
    resources.forEach(repo => rel.Components.add(repo.componentName || "main"));

    // Add control archs
    for (const repo of resources) (await this.getUniqData("controlFile.Architecture", {repositoryID: repo.id})).forEach(arch => rel.Architectures.add(arch));

    for (const arch of rel.getArchs()) for (const comp of rel.getComponents()) {
      (await Promise.all([
        this.createPackage(repositoryName, comp, arch, {appRoot, compress: "xz"}),
        this.createPackage(repositoryName, comp, arch, {appRoot, compress: "gz"}),
        this.createPackage(repositoryName, comp, arch, {appRoot}),
      ])).forEach(({fileSize, filePath, md5, sha1, sha256, sha512}) => {
        rel.md5.add({size: fileSize, path: filePath, hash: md5});
        rel.SHA1.add({size: fileSize, path: filePath, hash: sha1});
        rel.SHA256.add({size: fileSize, path: filePath, hash: sha256});
        rel.SHA512.add({size: fileSize, path: filePath, hash: sha512});
      });
    }

    return rel;
  }

  async getPackageFile(packageTarget: dbStorage): Promise<stream.Readable> {
    const source = this.getResouces().find(data => data.id === packageTarget.repositoryID);
    if (!source) throw new Error("Package Source no more avaible please sync packages!");
    let saveCache: string;
    if (this.#appConfig.serverConfig?.dataFolder) {
      const cacheFolder = path.join(this.#appConfig.serverConfig.dataFolder, "deb_cache");
      if (!(await extendsFS.exists(cacheFolder))) await fs.mkdir(cacheFolder, {recursive: true});
      const { MD5sum, SHA1, SHA256, SHA512 } = packageTarget.controlFile;
      for (const hash of ([MD5sum, SHA1, SHA256, SHA512])) {
        if (!hash) continue
        const filePath = path.join(cacheFolder, `${hash}.deb`);
        if (await extendsFS.exists(filePath)) return createReadStream(filePath);
        else if (!saveCache) saveCache = filePath;
      }
    }

    if (source.type === "http") {
      const { url, auth: { header: headers, query } } = source;
      return coreHTTP.streamRequest(url, {headers, query}).then(src => {
        if (saveCache) src.pipe(createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "mirror") {
      const { debUrl } = packageTarget.restoreFile;
      return coreHTTP.streamRequest(debUrl).then(src => {
        if (saveCache) src.pipe(createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "github") {
      const { token } = source, { url } = packageTarget.restoreFile;
      return coreHTTP.streamRequest(url, {headers: token ? {"Authorization": "token "+token} : {}}).then(src => {
        if (saveCache) src.pipe(createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "oracle_bucket") {
      const { authConfig } = source, { restoreFile: { path } } = packageTarget;
      const bucket = await oracleBucket.oracleBucket(authConfig);
      return bucket.getFileStream(path).then(src => {
        if (saveCache) src.pipe(createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "google_driver") {
      const { clientId, clientSecret, clientToken } = source, { restoreFile: { id } } = packageTarget;
      const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
      return gdrive.getFileStream(id).then(src => {
        if (saveCache) src.pipe(createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "docker") {
      const { image, auth } = source, { ref, path: debPath } = packageTarget.restoreFile;
      const registry = new dockerRegistry(image, auth);
      return new Promise<stream.Readable>((done, reject) => registry.extractLayer(ref).then(tar => tar.on("error", reject).on("File", entry => entry.path === debPath ? done(entry.stream) : null))).then(src => {
        if (saveCache) src.pipe(createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    }
    throw new Error("Check package type");
  }

  async registerSource(target: repositorySource, callback?: (error?: any, control?: dpkg.debianControl) => void) {
    callback ??= (_void1, _void2) => {};
    const { id } = target;
    if (target.type === "http") {
      try {
        const control = await dpkg.parsePackage(await coreHTTP.streamRequest(target.url, {headers: target.auth?.header, query: target.auth?.query}));
        await this.addPackage(id, control, {});
        callback(null, control);
      } catch (err) {
        callback(err, null);
      }
    } else if (target.type === "oracle_bucket") {
      const { authConfig, path = [] } = target;
      const bucket = await oracleBucket.oracleBucket(authConfig);
      try {
        if (path.length === 0) path.push(...((await bucket.listFiles()).filter(k => k.name.endsWith(".deb")).map(({name}) => name)));
        for (const file of path) {
          const control = await dpkg.parsePackage(await bucket.getFileStream(file));
          await this.addPackage(id, control, {path: file});
          callback(null, control);
        }
      } catch (err) {
        callback(err, null);
      }
    } else if (target.type === "google_driver") {
      const { clientId, clientSecret, clientToken, gIds = [] } = target;
      if (!clientToken) throw new Error(`Cannot get files from ${id}, Google driver token is blank`);
      const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
      if (gIds.length === 0) gIds.push(...((await gdrive.listFiles()).filter(rel => rel.name.endsWith(".deb")).map(({id}) => id)));
      for (const file of gIds) {
        try {
          const control = await dpkg.parsePackage(await gdrive.getFileStream(file));
          await this.addPackage(id, control, {id: file});
          callback(null, control);
        } catch (err) {
          callback(err, null);
        }
      }
    } else if (target.type === "github") {
      const { owner, repository, token } = target;
      const gh = await Github.GithubManeger(owner, repository, token);
      if (target.subType === "branch") {
        const { branch = (await gh.branchList()).at(0)?.name ?? "main" } = target;
        for (const { path: filePath } of (await gh.trees(branch)).tree.filter(file => file.type === "tree" ? false : file.path.endsWith(".deb"))) {
          try {
            const rawURL = new URL(path.posix.join(owner, repository, branch, filePath), "https://raw.githubusercontent.com");
            const control = await dpkg.parsePackage(await coreHTTP.streamRequest(rawURL, {headers: token ? {Authorization: `token ${token}`} : {}}));
            await this.addPackage(id, control, {url: rawURL.toString()});
            callback(null, control);
          } catch (err) {
            callback(err, null);
          }
        }
      } else {
        const { tag = [] } = target;
        if (!tag.length) tag.push(...((await gh.tags()).map(d => d.name)));
        for (const tagName of tag) {
          try {
            const assets = (await gh.getRelease(tagName)).assets.filter(({name}) => name.endsWith(".deb"));
            for (const asset of assets) {
              const control = await dpkg.parsePackage(await coreHTTP.streamRequest(asset.browser_download_url, {headers: token ? {Authorization: `token ${token}`} : {}}));
              await this.addPackage(id, control, {url: asset.browser_download_url});
              callback(null, control);
            }
          } catch (err) {
            callback(err, null);
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
            blob.on("error", err => callback(err, null)).on("File", async entry => {
              if (!(entry.path.endsWith(".deb"))) return null;
              const control = await dpkg.parsePackage(entry.stream);
              await this.addPackage(id, control, {ref: layer.digest, path: entry.path});
              callback(null, control);
            });
            await new Promise<void>((done) => blob.on("close", done));
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
      const { config = [] } = target;
      const readFile = (path: string, start: number, end: number) => new Promise<Buffer>((done, reject) => {
        let buf: Buffer[] = [];
        oldFs.createReadStream(path, { start, end }).on("error", reject).on("data", (data: Buffer) => buf.push(data)).on("close", () => {done(Buffer.concat(buf)); buf = null;});
      });
      for (const aptSrc of config.filter(d => d.type === "packages")) {
        const main_url = new URL(aptSrc.src);
        const distMain = new URL(path.posix.join(main_url.pathname, "dists", aptSrc.distname), main_url);
        const release = apt.parseRelease(await coreHTTP.bufferRequestBody(distMain.toString()+"/InRelease").then(async data => (await openpgp.readCleartextMessage({cleartextMessage: data.toString()})).getText()).catch(() => coreHTTP.bufferRequestBody(distMain.toString()+"/Release").then(data => data.toString())));
        for (const Component of release.Components) for (const Arch of release.Architectures.filter(arch => arch !== "all")) {
          for (const ext of (["", ".gz", ".xz"])) {
            const mainReq = new URL(path.posix.join(distMain.pathname, Component, `binary-${Arch}`, `Packages${ext}`), distMain);
            const tmpFile = (path.join(tmpdir(), Buffer.from(mainReq.toString(), "utf8").toString("hex")))+".package";
            try {
              await streamPromise.finished((await coreHTTP.streamRequest(mainReq)).pipe(decompress()).pipe(oldFs.createWriteStream(tmpFile)));
              const packagesLocation: {start: number, end: number}[] = [];
              let start: number = 0, currentChuck = 0;
              await streamPromise.finished(oldFs.createReadStream(tmpFile).on("data", (chunk: Buffer) => {
                for (let i = 0; i < chunk.length; i++) if ((chunk[i - 1] === 0x0A) && (chunk[i] === 0x0A)) {
                  packagesLocation.push({
                    start,
                    end: i + currentChuck,
                  });
                  start = (i + currentChuck)+1;
                }
                currentChuck += Buffer.byteLength(chunk, "binary");
              }));
              for (const { start, end } of packagesLocation) {
                const control = dpkg.parseControl(await readFile(tmpFile, start, end));
                await this.addPackage(id, control, {
                  debUrl: (new URL(path.posix.join(main_url.pathname, control.Filename), main_url)).toString()
                });
                callback(null, control);
              }
              await fs.rm(tmpFile);
              break;
            } catch (err) {
              callback(err, null);
            }
          }
        }
      }
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
      mongoCollection: collection,
      async close() {await mongoClient.close();},
      async register(data) {await collection.insertOne(data);},
      async rawSearch(search) {return collection.find(search).toArray();},
      async deleteSource(repositoryID) {
        await collection.deleteMany({repositoryID});
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
  } else if (database.drive === "local") {
    const { dataFolder } = config.serverConfig;
    const dbFolder = path.join(dataFolder, "database");
    await fs.mkdir(dbFolder, {recursive: true});
    return new databaseManeger(config, {
      async deleteSource(repositoryID) {
        const idFolder = path.join(dbFolder, repositoryID);
        if (!(await extendsFS.exists(idFolder))) return;
        await fs.rm(idFolder, {recursive: true});
      },
      async register(data) {
        const hash = data.controlFile.SHA256 || data.controlFile.MD5sum;
        if (!hash) return;
        const packageHash = path.join(dbFolder, data.repositoryID, `${hash}.json`);
        if (!(await extendsFS.exists(path.dirname(packageHash)))) await fs.mkdir(path.dirname(packageHash), {recursive: true});
        await fs.writeFile(packageHash, JSON.stringify(data));
      },
      async rawSearch(inDb) {
        const data = [];
        function search(data: any, searchObj: any) {
          if (typeof data === "object" && !(data === null)) {
            if (Object.keys(data).length > 0) for (const key of Object.keys(data)) if (search(data[key], searchObj[key])) return true;
          }
          return data === searchObj;
        };
        await fs.mkdir(dbFolder, {recursive: true});;
        for (const repoID of await fs.readdir(dbFolder)) {
          for (const packagesHash of await fs.readdir(path.join(dbFolder, repoID))) {
            try {
              const pkgObj: dbStorage = JSON.parse(await fs.readFile(path.join(dbFolder, repoID, packagesHash), "utf8"));
              if (search(inDb, pkgObj)) data.push(pkgObj);
            } catch {
              await fs.rm(path.join(dbFolder, repoID, packagesHash)).catch(() => {});
            }
          }
        }
        return data;
      },
    });
  }
  throw new Error("Invalid drive config");
}