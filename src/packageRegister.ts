import { MongoClient, ServerApiVersion } from "mongodb";
import { promises as fs, createReadStream } from "node:fs";
import { aptSConfig , repositoryFrom} from "./configManeger.js";
import coreUtils, { DebianPackage, httpRequest, httpRequestGithub } from "@sirherobrine23/coreutils";
import { format } from "node:util";
import stream from "node:stream";
import path from "node:path";
import tar from "tar";
import zlib from "node:zlib";
import lzma from "lzma-native";
import openpgp from "openpgp";

export type restoreStream = {
  from: "url",
  url: string
}|{
  from: "docker",
  digest: string,
  image: string,
  path: string
}|{
  from: "tar",
  url: string,
  filePath: string
}|{
  from: "file",
  filePath: string
}|{
  from: "oracle_bucket",
  filePath: string,
}|{
  from: "google_driver",
  fileID: string,
};

export type packageStorage = {
  dist: string,
  component: string,
  restoreStream: restoreStream,
  repositoryFrom?: repositoryFrom
  packageControl: DebianPackage.debianControl,
};

export type packagesManeger = {
  getDists: () => Promise<string[]>,
  getDistInfo: (dist: string) => Promise<{components: string[], arch: string[], packages: string[]}>,
  getPackages: (dist?: string, component?: string) => Promise<packageStorage[]>,
  getFileStream: (dist: string, component: string, packageName: string, version: string, arch: string) => Promise<stream.Readable>,
  addPackage: (config: packageStorage) => Promise<void>,
  deletePackage: (config: packageStorage) => Promise<packageStorage>,
};

export async function genericStream(packageData: packageStorage): Promise<stream.Readable> {
  if (!packageData) throw new Error("Package not found!");
  if (typeof packageData.restoreStream === "string") packageData.restoreStream = JSON.parse(packageData.restoreStream);
  if (packageData.restoreStream.from === "url") {
    if (packageData.repositoryFrom?.type === "http") return coreUtils.httpRequest.pipeFetch({
      url: packageData.restoreStream.url,
      headers: packageData.repositoryFrom.auth?.header,
      query: packageData.repositoryFrom.auth?.query
    });
    return coreUtils.httpRequest.pipeFetch(packageData.restoreStream.url);
  } else if (packageData.restoreStream.from === "tar") {
    const inf = packageData.restoreStream;
    const tarStream = coreUtils.httpRequestLarge.Tar(packageData.restoreStream.url);
    return new Promise((resolve, reject) => {
      tarStream.listFiles((data) => {
        if (data.path === inf.filePath) return resolve(data as any);
      }).catch(reject).then(() => reject(new Error("File not found!")));
    });
  } else if (packageData.restoreStream.from === "docker") {
    const inf = packageData.restoreStream;
    const oci = await coreUtils.DockerRegistry(inf.image, packageData.repositoryFrom?.type === "docker" ? packageData.repositoryFrom.platformConfig : undefined);
      return new Promise((done, reject) => {
        oci.blobLayerStream(inf.digest).then((stream) => {
          stream.pipe(tar.list({
            filter: (path) => path === inf.path,
            onentry: (entry) => done(entry as any)
          }))
        }).catch(reject);
      });
  }
  throw new Error("Restore stream not supported!");
}

export default packageManeger;
export async function packageManeger(serverConfig: aptSConfig) {
  const partialConfig: Partial<packagesManeger> = {};
  if (serverConfig.db?.type === "mongodb") {
    const dbConfig = serverConfig.db;
    console.log("Connecting to MongoDB...");
    const mongoClient = await (new MongoClient(serverConfig.db.url, {serverApi: ServerApiVersion.v1})).connect();
    const collection = mongoClient.db(dbConfig.db ?? "apt-stream").collection<packageStorage>(dbConfig.collection ?? "packages");
    console.log("Connected to MongoDB!");

    partialConfig.getDists = async () => await collection.distinct("dist");

    partialConfig.getDistInfo = async (dist) => {
      const packages = await collection.find({dist}).toArray();
      if (!packages.length) throw new Error("Distribution not found!");
      return packages.reduce((dist, curr) => {
        if (!dist.components) dist.components = [];
        if (!dist.arch) dist.arch = [];
        if (!dist.packages) dist.packages = [];
        if (!dist.components.includes(curr.component)) dist.components.push(curr.component);
        if (!dist.arch.includes(curr.packageControl.Architecture)) dist.arch.push(curr.packageControl.Architecture);
        if (!dist.packages.includes(curr.packageControl.Package)) dist.packages.push(curr.packageControl.Package);
        return dist;
      }, {} as Partial<Awaited<ReturnType<packagesManeger["getDistInfo"]>>>) as Awaited<ReturnType<packagesManeger["getDistInfo"]>>;
    }

    partialConfig.getPackages = async (dist, component) => {
      const query: any = {};
      if (dist) query.dist = dist;
      if (component) query.component = component;
      return collection.find(query).toArray();
    }

    partialConfig.addPackage = async (config) => {
      const exists = await collection.findOne({
        dist: config.dist,
        component: config.component,
        "packageControl.Package": config.packageControl.Package,
        "packageControl.Version": config.packageControl.Version,
        "packageControl.Architecture": config.packageControl.Architecture
      });
      if (exists) throw new Error(format("Package (%s/%s %s/%s) already exists!", config.dist, config.component, config.packageControl.package, config.packageControl.version));
      await collection.insertOne(config);
    }
    partialConfig.deletePackage = async (config) => {
      return collection.findOneAndDelete({
        dist: config.dist,
        component: config.component,
        "packageControl.Package": config.packageControl.Package,
        "packageControl.Version": config.packageControl.Version,
        "packageControl.Architecture": config.packageControl.Architecture
      }).then((data) => data.value);
    }

    partialConfig.getFileStream = async (dist, component, packageName, version, arch) => {
      const packageData = await collection.findOne({dist, component, "package.package": packageName, "package.version": version, "package.architecture": arch});
      if (!packageData) throw new Error("Package not found!");
      return genericStream(packageData);
    }
  } else if (serverConfig.db?.type === "internal") {
    const rootSave = path.resolve(serverConfig.db.rootPath);
    if (!await coreUtils.extendFs.exists(rootSave)) await fs.mkdir(rootSave, {recursive: true});
  } else {
    const interalPackages: packageStorage[] = [];
    partialConfig.getPackages = async (dist, component) => interalPackages.filter((curr) => (!dist || curr.dist === dist) && (!component || curr.component === component));
    partialConfig.getDists = async () => interalPackages.reduce((dists, curr) => {if (!dists.includes(curr.dist)) dists.push(curr.dist); return dists;}, []);
    partialConfig.getDistInfo = async (dist) => {
      const packages = interalPackages.filter((curr) => curr.dist === dist);
      if (!packages.length) throw new Error("Distribution not found!");
      return packages.reduce((dist, curr) => {
        if (!dist.components) dist.components = [];
        if (!dist.arch) dist.arch = [];
        if (!dist.packages) dist.packages = [];
        if (!dist.components.includes(curr.component)) dist.components.push(curr.component);
        if (!dist.arch.includes(curr.packageControl.Architecture)) dist.arch.push(curr.packageControl.Architecture);
        if (!dist.packages.includes(curr.packageControl.Package)) dist.packages.push(curr.packageControl.Package);
        return dist;
      }, {} as Partial<Awaited<ReturnType<packagesManeger["getDistInfo"]>>>) as Awaited<ReturnType<packagesManeger["getDistInfo"]>>;
    };
    partialConfig.getFileStream = async (dist, component, packageName, version, arch) => {
      const packageData = interalPackages.find((curr) => curr.dist === dist && curr.component === component && curr.packageControl.Package === packageName && curr.packageControl.Version === version && curr.packageControl.Architecture === arch);
      if (!packageData) throw new Error("Package not found!");
      return genericStream(packageData);
    }
    partialConfig.addPackage = async (config) => {
      const exists = interalPackages.find((curr) => curr.dist === config.dist && curr.component === config.component && curr.packageControl.Package === config.packageControl.Package && curr.packageControl.Version === config.packageControl.Version && curr.packageControl.Architecture === config.packageControl.Architecture);
      if (exists) throw new Error(format("Package (%s/%s %s/%s) already exists!", config.dist, config.component, config.packageControl.package, config.packageControl.version));
      interalPackages.push(config);
    }
    partialConfig.deletePackage = async (config) => {
      const packageIndex = interalPackages.findIndex((curr) => curr.dist === config.dist && curr.component === config.component && curr.packageControl.Package === config.packageControl.Package && curr.packageControl.Version === config.packageControl.Version && curr.packageControl.Architecture === config.packageControl.Architecture);
      if (packageIndex === -1) throw new Error("Package not found!");
      return interalPackages.splice(packageIndex, 1).at(-1);
    }
  }
  return partialConfig as packagesManeger;
}

export async function loadRepository(addFunction: packagesManeger["addPackage"], distName: string, fromRepo: repositoryFrom, options?: {addFn: (data: DebianPackage.debianControl) => void}) {
  if (fromRepo.type === "github") {
    const { owner, repository, token, subType, componentName } = fromRepo;
    if (subType === "release") {
      const { tag } = fromRepo;
      let filesRes: httpRequestGithub.githubRelease[] = [];
      if (Array.isArray(tag) && tag?.length > 0) filesRes = await Promise.all(tag.map(async (tag) => httpRequestGithub.getRelease({owner, repository, releaseTag: tag, token}))).then((res) => res.flat());
      else filesRes = await httpRequestGithub.getRelease({owner, repository, token, all: true});
      filesRes = filesRes.filter(({assets}, index) => (filesRes[index].assets = assets.filter(({name}) => name.endsWith(".deb"))).length);
      for (const {assets, tag_name} of filesRes) {
        for (const {browser_download_url} of assets) {
          await coreUtils.httpRequest.pipeFetch({url: browser_download_url, headers: token ? {Authorization: `token ${token}`}:undefined}).then(stream => {
            return new Promise<void>((done, reject) => {
              let size = 0;
              const hash = coreUtils.extendsCrypto.createHashAsync("all", stream);
              stream.on("data", (data) => size += data.length).on("error", reject).pipe(coreUtils.Ar((info, stream) => {
                if (!info.name.startsWith("control.tar")) return null;
                if (info.name.endsWith(".xz")) stream = stream.pipe(lzma.Decompressor());
                else if (info.name.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
                stream.on("error", reject);
                let controlBuffer: Buffer;
                return stream.pipe(tar.list({
                  filter: (filePath) => path.basename(filePath) === "control",
                  onentry: (entry) => entry.on("data", (data) => controlBuffer = controlBuffer ? Buffer.concat([controlBuffer, data]) : data).once("end", async () => {
                    const waitedHash = await hash;
                    const packageControl = DebianPackage.parseControl(controlBuffer);
                    controlBuffer = null;
                    packageControl.Size = size;
                    packageControl.SHA256 = waitedHash.sha256;
                    packageControl.SHA1 = waitedHash.sha1;
                    packageControl.MD5sum = waitedHash.md5;
                    return addFunction({
                      dist: distName,
                      component: componentName ?? tag_name,
                      repositoryFrom: fromRepo,
                      packageControl,
                      restoreStream: {
                        from: "url",
                        url: browser_download_url
                      }
                    }).then(() => {
                      if (options?.addFn) options.addFn(packageControl);
                      done();
                    }).catch(reject);
                  }).on("error", reject)
                })).on("error" as any, reject);
              }).on("error", reject)).on("error", reject);
            });
          }).catch((err) => {
            console.error(err);
          });
        }
      }
    } else if (subType === "branch") {
      const { branch } = fromRepo;
      const files = (await httpRequestGithub.githubTree(owner, repository, branch)).tree.filter(({path}) => path.endsWith(".deb"));
      for (const {path: filePath} of files) {
        const parseURL = new URL(`https://raw.githubusercontent.com/${owner}/${repository}/${branch}`);
        parseURL.pathname = path.posix.normalize(path.posix.join(parseURL.pathname, filePath));
        const url = parseURL.toString();
        await coreUtils.httpRequest.pipeFetch({url, headers: token ? {Authorization: `token ${token}`} : undefined}).then(stream => {
          return new Promise<void>((done, reject) => {
            let size = 0;
            const hash = coreUtils.extendsCrypto.createHashAsync("all", stream);
            return stream.on("data", (data) => size += data.length).on("error", reject).pipe(coreUtils.Ar((info, stream) => {
              if (!info.name.startsWith("control.tar")) return null;
              if (info.name.endsWith(".xz")) stream = stream.pipe(lzma.Decompressor());
              else if (info.name.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
              stream.on("error", reject);
              let controlBuffer: Buffer;
              return stream.pipe(tar.list({
                filter: (filePath) => path.basename(filePath) === "control",
                onentry: (entry) => entry.on("data", (data) => controlBuffer = controlBuffer ? Buffer.concat([controlBuffer, data]) : data).once("end", async () => {
                  const waitedHash = await hash;
                  const packageControl = DebianPackage.parseControl(controlBuffer);
                  controlBuffer = null;
                  packageControl.Size = size;
                  packageControl.SHA256 = waitedHash.sha256;
                  packageControl.SHA1 = waitedHash.sha1;
                  packageControl.MD5sum = waitedHash.md5;
                  return addFunction({
                    dist: distName,
                    component: "main",
                    packageControl,
                    restoreStream: {
                      from: "url",
                      url
                    },
                    repositoryFrom: fromRepo
                  }).then(() => {
                    if (options?.addFn) options.addFn(packageControl);
                    done();
                  }).catch(reject);
                }).on("error", reject)
              })).on("error" as any, reject);
            }).on("error", reject));
          });
        }).catch((err) => {
          console.error(err);
        });
      }
    }
  } else if (fromRepo.type === "http") {
    const { url, auth } = fromRepo;
    await coreUtils.httpRequest.pipeFetch({url, headers: auth?.header, query: auth?.query}).then(stream => {
      return new Promise<void>((done, reject) => {
        const hash = coreUtils.extendsCrypto.createHashAsync("all", stream);
        let size = 0;
        return stream.on("data", (data) => size += data.length).on("error", reject).pipe(coreUtils.Ar((info, stream) => {
          if (!info.name.startsWith("control.tar")) return null;
          if (info.name.endsWith(".xz")) stream = stream.pipe(lzma.Decompressor());
          else if (info.name.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
          stream.on("error", reject);
          let controlBuffer: Buffer;
          return stream.pipe(tar.list({
            filter: (filePath) => path.basename(filePath) === "control",
            onentry: (entry) => entry.on("data", (data) => controlBuffer = controlBuffer ? Buffer.concat([controlBuffer, data]) : data).once("end", async () => {
              const waitedHash = await hash;
              const packageControl = DebianPackage.parseControl(controlBuffer);
              controlBuffer = null;
              packageControl.Size = size;
              packageControl.SHA256 = waitedHash.sha256;
              packageControl.SHA1 = waitedHash.sha1;
              packageControl.MD5sum = waitedHash.md5;
              return addFunction({
                dist: distName,
                component: "main",
                packageControl,
                restoreStream: {
                  from: "url",
                  url
                },
                repositoryFrom: fromRepo
              }).then(() => {
                if (options?.addFn) options.addFn(packageControl);
                done();
              }).catch(reject);
            }).on("error", reject)
          })).on("error" as any, reject);
        }).on("error", reject));
      });
    });
  } else if (fromRepo.type === "local") {
    const { path: folderPath } = fromRepo;
    const files = (await coreUtils.extendFs.readdir({folderPath})).filter(x => x.endsWith(".deb"));
    for (const filePath of files) {
      await new Promise<void>((done, reject) => {
        const stream = createReadStream(filePath);
        let size = 0;
        const hash = coreUtils.extendsCrypto.createHashAsync("all", stream);
        return stream.on("data", (data) => size += data.length).on("error", reject).pipe(coreUtils.Ar((info, stream) => {
          if (!info.name.startsWith("control.tar")) return null;
          if (info.name.endsWith(".xz")) stream = stream.pipe(lzma.Decompressor());
          else if (info.name.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
          stream.on("error", reject);
          let controlBuffer: Buffer;
          return stream.pipe(tar.list({
            filter: (filePath) => path.basename(filePath) === "control",
            onentry: (entry) => entry.on("data", (data) => controlBuffer = controlBuffer ? Buffer.concat([controlBuffer, data]) : data).once("end", async () => {
              const waitedHash = await hash;
              const packageControl = DebianPackage.parseControl(controlBuffer);
              controlBuffer = null;
              packageControl.Size = size;
              packageControl.SHA256 = waitedHash.sha256;
              packageControl.SHA1 = waitedHash.sha1;
              packageControl.MD5sum = waitedHash.md5;
              return addFunction({
                dist: distName,
                component: fromRepo.componentName ?? "main",
                packageControl,
                restoreStream: {from: "file", filePath},
                repositoryFrom: fromRepo
              }).then(() => {
                if (options?.addFn) options.addFn(packageControl);
                done();
              }).catch(reject);
            }).on("error", reject)
          })).on("error" as any, reject);
        }).on("error", reject));
      }).catch((err) => {
        console.error(err);
      });
    }
  } else if (fromRepo.type === "oracle_bucket") {
    const { namespace, bucket, region, auth, componentName } = fromRepo;
    const oracleBucket = await coreUtils.oracleBucket(region as any, bucket, namespace, auth);
    const files = (await oracleBucket.fileList()).filter(x => x.name.endsWith(".deb"));
    for (const file of files) {
      await oracleBucket.getFileStream(file.name).then(stream => {
        return new Promise<void>((done, reject) => {
          const hash = coreUtils.extendsCrypto.createHashAsync("all", stream);
          let size = 0;
          return stream.on("data", (data) => size += data.length).pipe(coreUtils.Ar((info, stream) => {
            if (!info.name.startsWith("control.tar")) return null;
            if (info.name.endsWith(".xz")) stream = stream.pipe(lzma.Decompressor());
            else if (info.name.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
            stream.on("error", reject);
            let controlBuffer: Buffer;
            return stream.pipe(tar.list({
              filter: (filePath) => path.basename(filePath) === "control",
              onentry: (entry) => entry.on("data", (data) => controlBuffer = controlBuffer ? Buffer.concat([controlBuffer, data]) : data).once("end", async () => {
                const waitedHash = await hash;
                const packageControl = DebianPackage.parseControl(controlBuffer);
                controlBuffer = null;
                packageControl.Size = size;
                packageControl.SHA256 = waitedHash.sha256;
                packageControl.SHA1 = waitedHash.sha1;
                packageControl.MD5sum = waitedHash.md5;
                return addFunction({
                  dist: distName,
                  component: componentName ?? "main",
                  packageControl,
                  restoreStream: {
                    from: "oracle_bucket",
                    filePath: file.name
                  },
                  repositoryFrom: fromRepo
                }).then(() => {
                  if (options?.addFn) options.addFn(packageControl);
                  done();
                }).catch(reject);
              }).on("error", reject)
            })).on("error" as any, reject);
          })).on("error", reject);
        });
      }).catch((err) => {
        console.error(err);
      });
    }
  } else if (fromRepo.type === "google_driver") {
    const { app, id, componentName = "main" } = fromRepo;
    const googleDriver = await coreUtils.googleDriver.GoogleDriver(app.id, app.secret, {token: app.token, async authCallback(url, token) {
      if (url) throw new Error("Please correct setup google driver auth");
      app.token = token;
    }});
    const files = (await (id?.length > 0 ? Promise.all(id.map(x => googleDriver.listFiles(x))).then(a => a.flat(2)) : googleDriver.listFiles())).filter(x => x.name.endsWith(".deb"));
    for (const file of files) {
      await googleDriver.getFileStream(file.id).then(stream => {
        return new Promise<void>((done, reject) => {
          let size = 0;
          const hash = coreUtils.extendsCrypto.createHashAsync("all", stream);
          return stream.on("error", reject).on("data", (data) => size += data.length).pipe(coreUtils.Ar((info, stream) => {
            if (!info.name.startsWith("control.tar")) return null;
            if (info.name.endsWith(".xz")) stream = stream.pipe(lzma.Decompressor());
            else if (info.name.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
            stream.on("error", reject);
            let controlBuffer: Buffer;
            return stream.pipe(tar.list({
              filter: (filePath) => path.basename(filePath) === "control",
              onentry: (entry) => entry.on("data", (data) => controlBuffer = controlBuffer ? Buffer.concat([controlBuffer, data]) : data).once("end", async () => {
                const waitedHash = await hash;
                const packageControl = DebianPackage.parseControl(controlBuffer);
                controlBuffer = null;
                packageControl.Size = size;
                packageControl.SHA256 = waitedHash.sha256;
                packageControl.SHA1 = waitedHash.sha1;
                packageControl.MD5sum = waitedHash.md5;
                return addFunction({
                  dist: distName,
                  component: componentName,
                  packageControl,
                  restoreStream: {
                    from: "google_driver",
                    fileID: file.id
                  },
                  repositoryFrom: fromRepo
                }).then(() => {
                  if (options?.addFn) options.addFn(packageControl);
                  done();
                }).catch(reject);
              }).on("error", reject)
            })).on("error" as any, reject);
          }));
        });
      }).catch((err) => {
        console.error(err);
      });
    }
  } else if (fromRepo.type === "docker") {
    const { image, platformConfig, componentName } = fromRepo;
    const docker = await coreUtils.DockerRegistry(image, platformConfig);
    const layers = await docker.imageManifest().then(x => ({token: x.token, x, layers: (x.layers as any[]).filter(x => (["gzip", "gz", "tar"]).some(ends => x.layer.mediaType.endsWith(ends))).map(x => x.layer.mediaType as string)}));
    for (const layer of layers.layers) {
      await docker.blobLayerStream(layer, layers.token).then(layerRaw => new Promise<void>((done, reject) => {
        return layerRaw.on("error", reject).pipe(tar.list({
          filter: (filePath) => filePath.endsWith(".deb"),
          onentry: (entry) => {
            const hash = coreUtils.extendsCrypto.createHashAsync("all", entry as any);
            let size = 0;
            return entry.on("data", (data) => size += data.length).on("error", reject).pipe(coreUtils.Ar((info, stream) => {
              if (!info.name.startsWith("control.tar")) return null;
              if (info.name.endsWith(".xz")) stream = stream.pipe(lzma.Decompressor());
              else if (info.name.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
              stream.on("error", reject);
              let controlBuffer: Buffer;
              return stream.pipe(tar.list({
                filter: (filePath) => path.basename(filePath) === "control",
                onentry: (entryControl) => entryControl.on("data", (data) => controlBuffer = controlBuffer ? Buffer.concat([controlBuffer, data]) : data).once("end", async () => {
                  const waitedHash = await hash;
                  const packageControl = DebianPackage.parseControl(controlBuffer);
                  controlBuffer = null;
                  packageControl.Size = size;
                  packageControl.SHA256 = waitedHash.sha256;
                  packageControl.SHA1 = waitedHash.sha1;
                  packageControl.MD5sum = waitedHash.md5;
                  return addFunction({
                    dist: distName,
                    component: componentName ?? "main",
                    packageControl,
                    restoreStream: {
                      from: "docker",
                      image,
                      digest: layer,
                      path: entry.path
                    },
                    repositoryFrom: fromRepo
                  }).then(() => {
                    if (options?.addFn) options.addFn(packageControl);
                    done();
                  }).catch(reject);
                }).on("error", reject)
              })).on("error" as any, reject);
            }));
          }
        })).on("error" as any, reject);
      })).catch((err) => {
        console.error(err);
      });
    }
  } else if (fromRepo.type === "mirror") {
    const { url, dists, componentName } = fromRepo;
    for (const mirrorDistName in dists) {
      const distsData = dists[mirrorDistName];
      const distURL = new URL(url);
      distURL.pathname = path.posix.resolve(distURL.pathname, "dists", mirrorDistName);
      const inReleaseURL = new URL("", distURL);
      const ReleaseURL = new URL("", distURL);
      inReleaseURL.pathname = path.posix.join(inReleaseURL.pathname, "InRelease");
      ReleaseURL.pathname = path.posix.join(ReleaseURL.pathname, "Release");

      await coreUtils.httpRequest.bufferFetch(inReleaseURL.toString()).catch(() => coreUtils.httpRequest.bufferFetch(ReleaseURL.toString())).then(res => res.data).then(async release => {
        if (release.subarray(0, 6).toString().startsWith("----")) release = Buffer.from(((await openpgp.readCleartextMessage({cleartextMessage: release.toString()})).getText()), "utf8");
        const releaseData = await coreUtils.DebianPackage.parseRelease(release);
        if (!releaseData.Architectures) {
          const archs = releaseData.Architectures as string[];
          if (!distsData.archs?.length) distsData.archs = archs;
          else distsData.archs = distsData.archs.filter((arch) => archs.includes(arch));
        }
        if (!releaseData.Components) {
          const components = releaseData.Components as string[];
          if (!distsData.components?.length) distsData.components = components;
          else distsData.components = distsData.components.filter((component) => components.includes(component));
        }
        for (const component of distsData.components) {
          for (const arch of distsData.archs) {
            const PackagesURL = new URL("", distURL);
            PackagesURL.pathname = path.posix.resolve(PackagesURL.pathname, component, "binary-" + arch, "Packages");
            const fixedUR = PackagesURL.toString();
            const stream = await httpRequest.pipeFetch(fixedUR).catch(() => httpRequest.pipeFetch(fixedUR+".gz").then(stream => stream.pipe(zlib.createGunzip()))).catch(() => httpRequest.pipeFetch(fixedUR+".xz").then(stream => stream.pipe(lzma.Decompressor()))).catch(err => console.log(err));
            if (!stream) continue;
            const packages = await DebianPackage.parsePackages(stream);
            for (const packageControl of packages) {
              if (!packageControl.Filename) continue;
              const fixFilename = new URL(packageControl.Filename, url);
              await addFunction({
                dist: distName,
                component: componentName ?? component,
                packageControl,
                restoreStream: {
                  from: "url",
                  url: fixFilename.toString()
                },
                repositoryFrom: fromRepo
              }).catch(err => console.error(err));
            }
          }
        }
      }).catch(err => {
        console.error(err);
      });
    }

  } else console.warn(`Unknown repository type: ${fromRepo["type"] ?? JSON.stringify(fromRepo)}`);
}
