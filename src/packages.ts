import { aptStreamConfig, configJSON, repositorySource } from "./config.js";
import { decompressStream, compressStream } from "@sirherobrine23/decompress";
import { googleDriver, oracleBucket } from "@sirherobrine23/cloud";
import { extendsCrypto, extendsFS } from "@sirherobrine23/extends";
import { apt, dpkg } from "@sirherobrine23/dpkg";
import { tmpdir } from "node:os";
import { format } from "node:util";
import oldFs, { promises as fs } from "node:fs";
import coreHTTP, { Github } from "@sirherobrine23/http";
import streamPromise, { finished } from "node:stream/promises";
import dockerRegistry from "@sirherobrine23/docker-registry";
import mongoDB from "mongodb";
import openpgp from "openpgp";
import stream from "node:stream";
import crypto from "node:crypto";
import path from "node:path";

export interface dbStorage {
  repositoryID: string;
  restoreFile: any;
  controlFile: dpkg.debianControl;
}

export interface userAuth {
  createAt: Date;
  username: string;
  token: string[];
}

export default async function main(initConfig: string|configJSON|aptStreamConfig) {
  return new Promise<packageManeger>((done, reject) => {
    const pkg = new packageManeger(initConfig, (err) => {
      if (err) return reject(err);
      return done(pkg);
    });
  });
}

export class packageManeger extends aptStreamConfig {
  #client: mongoDB.MongoClient;
  #collection: mongoDB.Collection<dbStorage>;
  #authCollection: mongoDB.Collection<userAuth>;
  async close() {this.#client.close()}
  constructor(initConfig: string|configJSON|aptStreamConfig, connectionCallback?: (err?: any) => void) {
    connectionCallback ||= (err) => {if(err) process.emit("warning", err);}
    super(initConfig);
    (async () => {
      const database = this.getDatabase();
      const mongoClient = this.#client = await (new mongoDB.MongoClient(database.url)).connect();
      mongoClient.on("error", err => console.error(err));
      this.#authCollection = mongoClient.db(database.databaseName || "aptStream").collection<userAuth>("auth");
      this.#collection = mongoClient.db(database.databaseName || "aptStream").collection<dbStorage>("packages");
    })().then(() => connectionCallback(), err => connectionCallback(err));
  }

  getClientInfo() {
    const connection = this.#client["topology"];
    return {
      connections: {
        max: Number(connection.s.options.maxConnecting),
        current: Number(connection.client.s.activeSessions?.size),
      }
    }
  }
  async createToken(username: string) {
    let token: string;
    while (true) {
      token = crypto.randomBytes(8).toString("hex");
      if (!(await this.#authCollection.findOne({token}))) break;
    }
    if (!(await this.#authCollection.findOne({username}))) await this.#authCollection.insertOne({username, createAt: new Date(), token: []});
    await this.#authCollection.findOneAndUpdate({username}, {$inc: {token: token as never}});
    return token;
  }

  async userAs(token: string) {
    return !!(await this.#authCollection.findOne({token: [String(token)]}));
  }

  async pkgQuery(query: mongoDB.Filter<dbStorage>) {
    return this.#collection.find(query).toArray();
  }

  async packagesCount() {
    return (await this.#collection.stats()).count;
  }

  async getPackagesHash() {
    return this.#collection.distinct("controlFile.MD5sum");
  }

  async repoInfo(repositoryName: string) {
    const repositorys = this.getRepository(repositoryName).getAllRepositorys();
    if (!repositorys.length) throw new Error("Repository or Component name not exists!");
    return {
      packagesCount: (await Promise.all(repositorys.map(async ({repositoryID}) => this.#collection.countDocuments({repositoryID})))).reduce((acc, count) => acc+count, 0),
      sources: repositorys.length,
    };
  }

  async createPackage(repositoryName: string, componentName: string, Arch: string, appRoot: string = "", options?: {compress?: "gz"|"xz", callback: (str: stream.Readable) => void}): Promise<{filePath: string; fileSize: number; sha512: string; sha256: string; sha1: string; md5: string;}[]> {
    const repositorys = this.getRepository(repositoryName).getAllRepositorys().filter(pkg => pkg.componentName === componentName);
    if (!repositorys.length) throw new Error("Repository or Component name not exists!");

    const str = new stream.Readable({autoDestroy: true, emitClose: true, read(_s){}});
    const gg: (Promise<{filePath: string; fileSize: number; sha512: string; sha256: string; sha1: string; md5: string;}>)[] = [];
    if (typeof options?.callback === "function") (async () => options.callback(str.pipe(compressStream(options.compress === "gz" ? "gzip" : options.compress === "xz" ? "xz" : "passThrough"))))().catch(err => str.emit("error", err));
    else {
      async function getHash(compress?: "gz"|"xz") {
        const com = stream.Readable.from(str.pipe(compressStream(compress === "gz" ? "gzip" : compress === "xz" ? "xz" : "passThrough")));
        return extendsCrypto.createHashAsync(com).then(({hash, byteLength}) => ({
          filePath: path.posix.join(componentName, "binary-"+Arch, "Packages"+(compress === "gz" ? ".gz" : compress === "xz" ? ".xz" : "")),
          fileSize: byteLength,
          sha512: hash.sha512,
          sha256: hash.sha256,
          sha1: hash.sha1,
          md5: hash.md5,
        }));
      }
      gg.push(getHash());
      if (this.getRelease("gzip")) gg.push(getHash("gz"));
      if (this.getRelease("xz")) gg.push(getHash("xz"));
    }
    (async () => {
      let breakLine = false;
      for (const repo of repositorys) {
        let pkgs: mongoDB.WithId<dbStorage>[], page = 0;
        while ((pkgs = await this.#collection.find({repositoryID: repo.repositoryID, "controlFile.Architecture": Arch}).skip(page).limit(2500).toArray()).length > 0) {
          page += pkgs.length;
          for (const {controlFile: pkg} of pkgs) {
            let pkgHash: string;
            if (!(pkgHash = pkg.MD5sum)) continue;
            if (breakLine) str.push("\n\n"); else breakLine = true;
            str.push(dpkg.createControl({
              ...pkg,
              Filename: path.posix.join("/", appRoot, "pool", `${pkgHash}.deb`).slice(1),
            }));
          }
        }
      }
      str.push(null);
    })().catch(err => str.emit("error", err));
    return Promise.all(gg);
  }

  async createRelease(repositoryName: string, appRoot: string) {
    const source = this.getRepository(repositoryName);
    const repositorys = source.getAllRepositorys();
    const releaseDate = (new Date()).toUTCString();
    const Architectures = await this.#collection.distinct("controlFile.Architecture", {repositoryID: {$in: repositorys.map(a => a.repositoryID)}});
    const Components = Array.from(new Set(repositorys.map(rpm => rpm.componentName)));
    const MD5Sum = new Set<{hash: string, size: number, path: string}>();
    const SHA1 = new Set<{hash: string, size: number, path: string}>();
    const SHA256 = new Set<{hash: string, size: number, path: string}>();
    const SHA512 = new Set<{hash: string, size: number, path: string}>();
    await Promise.all(Architectures.map(async arch => Promise.all(Components.map(async comp => this.createPackage(repositoryName, comp, arch, appRoot).then(res => res.forEach(({fileSize, filePath, md5, sha1, sha256, sha512}) => {
      MD5Sum.add({size: fileSize, path: filePath, hash: md5});
      SHA1.add({size: fileSize, path: filePath, hash: sha1});
      SHA256.add({size: fileSize, path: filePath, hash: sha256});
      SHA512.add({size: fileSize, path: filePath, hash: sha512});
    }), err => console.log(err))))));
    const toJSON = () => {
      if ((!Architectures.length) && (!Components.length)) throw new Error("Invalid config repository or not loaded to database!");
      const data = {
        Date: releaseDate,
        acquireByHash: false,
        Codename: source.getCodename(),
        Suite: source.getSuite(),
        Origin: source.getOrigin(),
        Label: source.getLabel(),
        Description: source.getDescription(),
        Architectures,
        Components,
        MD5Sum: Array.from(MD5Sum.values()).sort((a, b) => b.size - a.size),
        SHA1: Array.from(SHA1.values()).sort((a, b) => b.size - a.size),
        SHA256: Array.from(SHA256.values()).sort((a, b) => b.size - a.size),
        SHA512: Array.from(SHA512.values()).sort((a, b) => b.size - a.size),
      };
      if (!data.Architectures.length) throw new Error("Require one packages loaded to database!");
      return data;
    }

    const toString = () => {
      const reljson = toJSON();
      let configString: string[] = [
        "Date: "+(reljson.Date),
        "Acquire-By-Hash: no",
        "Architectures: "+(reljson.Architectures.join(" ")),
        "Components: "+(reljson.Components.join(" ")),
      ];

      if (reljson.Codename) configString.push(`Codename: ${reljson.Codename}`);
      if (reljson.Suite) configString.push(`Suite: ${reljson.Suite}`);
      if (reljson.Origin) configString.push(`Origin: ${reljson.Origin}`);
      if (reljson.Label) configString.push(`Label: ${reljson.Label}`);
      if (reljson.Description) configString.push(`Description: ${reljson.Description}`);

      const insertHash = (name: string, hashes: typeof reljson.MD5Sum) => {
        configString.push(name+":");
        const sizeLength = hashes.at(0).size.toString().length+2;
        for (const data of hashes) configString.push((" "+data.hash + " "+(Array(Math.max(1, Math.abs(sizeLength - (data.size.toString().length)))).fill("").join(" ")+(data.size.toString()))+" "+data.path))
      }
      if (reljson.MD5Sum.length > 0) insertHash("MD5Sum", reljson.MD5Sum);
      if (reljson.SHA1.length > 0) insertHash("SHA1", reljson.SHA1);
      if (reljson.SHA256.length > 0) insertHash("SHA256", reljson.SHA256);
      if (reljson.SHA512.length > 0) insertHash("SHA512", reljson.SHA512);

      return configString.join("\n");
    }

    const inRelease = async (type: "sign"|"clearMessage" = "sign"): Promise<string> => {
      if (!(source.getCodename()||source.getSuite())) throw new Error("Required Suite or Codename to create InRelease file");
      else if (!(MD5Sum.size||SHA256.size)) throw new Error("Require MD5 or SHA256 to create InRelease file");
      const gpgSign = this.getPGPKey();
      const privateKey = gpgSign.gpgPassphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: gpgSign.privateKey.keyContent }), passphrase: gpgSign.gpgPassphrase}) : await openpgp.readPrivateKey({ armoredKey: gpgSign.privateKey.keyContent });
      const text = toString();
      if (type === "clearMessage") return Buffer.from(await openpgp.sign({
        signingKeys: privateKey,
        format: "armored",
        message: await openpgp.createMessage({text})
      }) as any).toString("utf8");
      return openpgp.sign({
        signingKeys: privateKey,
        format: "armored",
        message: await openpgp.createCleartextMessage({text})
      });
    }
    return {
      toJSON,
      toString,
      inRelease
    }
  }

  async getPackageStream(packageTarget: dbStorage) {
    const source = this.getRepository(packageTarget.repositoryID).get(packageTarget.repositoryID);
    if (!source) throw new Error("Package Source no more avaible please sync packages!");
    let saveCache: string;
    if (await this.getDataStorage()) {
      const cacheFolder = path.join(await this.getDataStorage(), "deb_cache");
      if (!(await extendsFS.exists(cacheFolder))) await fs.mkdir(cacheFolder, {recursive: true});
      const { MD5sum, SHA1, SHA256, SHA512 } = packageTarget.controlFile;
      for (const hash of ([MD5sum, SHA1, SHA256, SHA512])) {
        if (!hash) continue
        const filePath = path.join(cacheFolder, `${hash}.deb`);
        if (await extendsFS.exists(filePath)) return oldFs.createReadStream(filePath);
        else if (!saveCache) saveCache = filePath;
      }
    }

    if (source.type === "http") {
      const { url, auth: { header: headers, query } } = source;
      return coreHTTP.streamRequest(url, {headers, query}).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "mirror") {
      const { debUrl } = packageTarget.restoreFile;
      return coreHTTP.streamRequest(debUrl).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "github") {
      const { token } = source, { url } = packageTarget.restoreFile;
      return coreHTTP.streamRequest(url, {headers: token ? {"Authorization": "token "+token} : {}}).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "oracleBucket") {
      const { authConfig } = source, { restoreFile: { path } } = packageTarget;
      const bucket = await oracleBucket.oracleBucket(authConfig);
      return bucket.getFileStream(path).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "googleDriver") {
      const { clientId, clientSecret, clientToken } = source, { restoreFile: { id } } = packageTarget;
      const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
      return gdrive.getFileStream(id).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "docker") {
      const { image, auth } = source, { ref, path: debPath } = packageTarget.restoreFile;
      const registry = new dockerRegistry.v2(image, auth);
      return new Promise<stream.Readable>((done, reject) => registry.extractLayer(ref).then(tar => tar.on("error", reject).on("File", entry => entry.path === debPath ? done(entry.stream) : null))).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    }
    throw new Error("Check package type");
  }

  async addPackage(repositoryID: string, control: dpkg.debianControl, restore: any): Promise<dbStorage> {
    if (Boolean(await this.#collection.findOne({
      repositoryID,
      "controlFile.Package": control.Package,
      "controlFile.Version": control.Version,
      "controlFile.Architecture": control.Architecture
    }))) {
      const { Package, Architecture, Version } = control;
      throw new Error(format("%s -> %s/%s (%s) are exists in database", repositoryID, Package, Architecture, Version));
    }
    await this.#collection.insertOne({
      repositoryID,
      restoreFile: restore,
      controlFile: control
    });
    return {
      repositoryID,
      restoreFile: restore,
      controlFile: control
    };
  }

  async syncRepositorys(callback?: (error?: any, dbStr?: dbStorage) => void) {
    const sources = this.getRepositorys().map(({repositoryManeger}) => repositoryManeger.getAllRepositorys()).flat(2);
    const toDelete = (await this.#collection.distinct("repositoryID")).filter(key => !sources.find(d => d.repositoryID === key));
    if (toDelete.length > 0) await this.#collection.deleteMany({repositoryID: toDelete});
    for (const repo of sources) await this.registerSource(repo.repositoryID, repo, callback);
    return toDelete;
  }

  async registerSource(repositoryID: string, target: repositorySource, callback?: (error?: any, dbStr?: dbStorage) => void) {
    callback ??= (_void1, _void2) => {};
    if (target.type === "http") {
      try {
        const control = (await dpkg.parsePackage(await coreHTTP.streamRequest(target.url, {headers: target.auth?.header, query: target.auth?.query}))).controlFile;
        callback(null, await this.addPackage(repositoryID, control, {}));
      } catch (err) {
        callback(err, null);
      }
    } else if (target.type === "oracleBucket") {
      const { authConfig, path = [] } = target;
      const bucket = await oracleBucket.oracleBucket(authConfig);
      try {
        if (path.length === 0) path.push(...((await bucket.listFiles()).filter(k => k.name.endsWith(".deb")).map(({name}) => name)));
        for (const file of path) {
          const control = (await dpkg.parsePackage(await bucket.getFileStream(file))).controlFile;
          callback(null, await this.addPackage(repositoryID, control, {path: file}));
        }
      } catch (err) {
        callback(err, null);
      }
    } else if (target.type === "googleDriver") {
      const { clientId, clientSecret, clientToken, gIDs = [] } = target;
      const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
      if (gIDs.length === 0) gIDs.push(...((await gdrive.listFiles()).filter(rel => rel.name.endsWith(".deb")).map(({id}) => id)));
      for (const file of gIDs) {
        try {
          const control = (await dpkg.parsePackage(await gdrive.getFileStream(file))).controlFile;
          callback(null, await this.addPackage(repositoryID, control, {id: file}));
        } catch (err) {
          callback(err, null);
        }
      }
    } else if (target.type === "github") {
      const { owner, repository, token } = target;
      const gh = await Github.repositoryManeger(owner, repository, {token});
      if (target.subType === "branch") {
        const { branch = (await gh.repository.listBranchs()).at(0)?.name ?? "main" } = target;
        for (const { path: filePath } of (await gh.git.getTree(branch)).tree.filter(file => file.type === "tree" ? false : (file.size > 10) && file.path.endsWith(".deb"))) {
          try {
            const rawURL = new URL(path.posix.join(owner, repository, branch, filePath), "https://raw.githubusercontent.com");
            const control = (await dpkg.parsePackage(gh.git.getRawFile(branch, filePath))).controlFile;
            callback(null, await this.addPackage(repositoryID, control, {url: rawURL.toString()}));
          } catch (err) {
            callback(err, null);
          }
        }
      } else {
        const { tag = [] } = target;
        if (!tag.length) tag.push(...((await gh.release.getRelease()).map(d => d.tag_name)));
        for (const tagName of tag) {
          try {
            const assets = (await gh.release.getRelease(tagName)).assets.filter(({name}) => name.endsWith(".deb"));
            for (const asset of assets) {
              const control = (await dpkg.parsePackage(await coreHTTP.streamRequest(asset.browser_download_url, {headers: token ? {Authorization: `token ${token}`} : {}}))).controlFile;
              callback(null, await this.addPackage(repositoryID, control, {url: asset.browser_download_url}));
            }
          } catch (err) {
            callback(err, null);
          }
        }
      }
    } else if (target.type === "docker") {
      const { image, auth, tags = [] } = target;
      const registry = new dockerRegistry.v2(image, auth);
      if (tags.length === 0) {
        const { sha256, tag } = registry.image;
        if (sha256) tags.push(sha256);
        else if (tag) tags.push(tag);
        else tags.push(...((await registry.getTags()).reverse().slice(0, 6)));
      }
      for (const tag of tags) {
        const manifestManeger = new dockerRegistry.Utils.Manifest(await registry.getManifets(tag), registry);
        const addPckage = async () => {
          for (const layer of manifestManeger.getLayers()) {
            const blob = await registry.extractLayer(layer.digest);
            blob.on("error", err => callback(err, null)).on("entry", async (entry, str, next) => {
              next();
              if (!(entry.name.endsWith(".deb"))) return null;
              try {
                const control = (await dpkg.parsePackage(stream.Readable.from(str))).controlFile;
                callback(null, await this.addPackage(repositoryID, control, {ref: layer.digest, path: entry.path}));
              } catch (err) {callback(err, null);}
            });
            await finished(blob);
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
              await streamPromise.finished((await coreHTTP.streamRequest(mainReq)).pipe(decompressStream()).pipe(oldFs.createWriteStream(tmpFile)));
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
                callback(null, await this.addPackage(repositoryID, control, {
                  debUrl: (new URL(path.posix.join(main_url.pathname, control.Filename), main_url)).toString()
                }));
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