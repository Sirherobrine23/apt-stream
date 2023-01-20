import { MongoClient, ServerApiVersion, Filter } from "mongodb";
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
  getFileStream: (info: {dist?: string, component: string, packageName: string, version: string, arch: string}) => Promise<stream.Readable>,
  addPackage: (config: packageStorage) => Promise<void>,
  deletePackage: (config: packageStorage) => Promise<packageStorage>,
  close: () => Promise<void>
};

export async function genericStream(packageData: packageStorage): Promise<stream.Readable> {
  if (!packageData) throw new Error("Package not found!");
  if (typeof packageData.restoreStream === "string") packageData.restoreStream = JSON.parse(packageData.restoreStream);
  if (packageData.restoreStream.from === "url") {
    if (packageData.repositoryFrom?.type === "http") return coreUtils.httpRequest.streamRequest({
      url: packageData.restoreStream.url,
      headers: packageData.repositoryFrom.auth?.header,
      query: packageData.repositoryFrom.auth?.query
    });
    return coreUtils.httpRequest.streamRequest(packageData.restoreStream.url);
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
  partialConfig.close = async () => {};
  if (serverConfig.db?.type === "mongodb") {
    const dbConfig = serverConfig.db;
    console.log("Connecting to MongoDB...");
    const mongoClient = await (new MongoClient(serverConfig.db.url, {serverApi: ServerApiVersion.v1})).connect();
    const collection = mongoClient.db(dbConfig.db ?? "apt-stream").collection<packageStorage>(dbConfig.collection ?? "packages");
    console.log("Connected to MongoDB!");
    partialConfig.close = async () => await mongoClient.close();
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
      if (exists) throw new Error(format("Package (%s/%s-%s in %s/%s) already exists!", exists.packageControl.Package, exists.packageControl.Version, exists.packageControl.Architecture, exists.dist, exists.component));
      await collection.insertOne(config);
    }
    partialConfig.deletePackage = async (config) => {
      return collection.findOneAndDelete({
        dist: config.dist,
        component: config.component,
        "packageControl.Package": config.packageControl.Package,
        "packageControl.Version": config.packageControl.Version,
        "packageControl.Architecture": config.packageControl.Architecture
      }).then((data) => !data?.value ? Promise.reject(new Error("Package not found!")) : data.value);
    }

    partialConfig.getFileStream = async (info) => {
      const objFind: Filter<packageStorage> = {
        dist: info.dist,
        component: info.component,
        "packageControl.Package": info.packageName,
        "packageControl.Version": info.version,
        "packageControl.Architecture": info.arch
      };
      for (const key in objFind) if (!objFind[key]) delete objFind[key];
      const packageData = await collection.findOne(objFind);
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
    partialConfig.getFileStream = async (info) => {
      const packageData = interalPackages.find((curr) => curr.dist === info.dist && curr.component === info.component && curr.packageControl.Package === info.packageName && curr.packageControl.Version === info.version && curr.packageControl.Architecture === info.arch);
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

export type loadRepositoryOptions = {
  distName: string,
  packageManeger: packagesManeger,
  repositoryFrom: repositoryFrom,
  /** Callback if to get erros and add new Package */
  callback?: (err?: Error, data?: DebianPackage.debianControl) => void
};
export async function loadRepository(options: loadRepositoryOptions) {
  const { repositoryFrom, packageManeger } = options;
  if (repositoryFrom.type === "local") {
    const { path: folderPath } = repositoryFrom;
    const packagesPath = (await coreUtils.extendFs.readdir({folderPath})).filter(x => x.endsWith(".deb"));
    for (const debianPackagePath of packagesPath) {
      try {
        const packageControl = await DebianPackage.getControl(createReadStream(debianPackagePath));
        await packageManeger.addPackage({
          dist: options.distName,
          component: repositoryFrom.componentName ?? "main",
          packageControl,
          repositoryFrom,
          restoreStream: {
            from: "file",
            filePath: debianPackagePath
          }
        }).then(() => {
          if (options.callback) options.callback(null, packageControl);
        }).catch(err => {
          if (options.callback) options.callback(err, null);
          else throw err;
        });
      } catch (err) {
        if (options.callback) options.callback(err, null);
        else throw err;
      }
    }
  } else if (repositoryFrom.type === "http") {
    const { url, auth: {header, query} } = repositoryFrom;
    try {
      const packageControl = await DebianPackage.getControl(await httpRequest.streamRequest({
        url,
        headers: header,
        query
      }));
      await packageManeger.addPackage({
        dist: options.distName,
        component: repositoryFrom.componentName ?? "main",
        packageControl,
        repositoryFrom,
        restoreStream: {
          from: "url",
          url
        }
      }).then(() => {
        if (options.callback) options.callback(null, packageControl);
      }).catch(err => {
        if (options.callback) options.callback(err, null);
        else throw err;
      });
    } catch (err) {
      if (options.callback) options.callback(err, null);
      else throw err;
    }
  } else if (repositoryFrom.type === "github") {
    const { owner, repository, token, subType } = repositoryFrom;
    const gh = await httpRequestGithub.GithubManeger(owner, repository, token);
    if (subType === "branch") {
      const { branch } = repositoryFrom;
      const rawRquests = (await gh.trees(branch)).tree.filter(x => x.path.endsWith(".deb")).map(x => {
        const rawURL = new URL(`https://raw.githubusercontent.com/${owner}/${repository}/${branch}`);
        rawURL.pathname = path.posix.join(rawURL.pathname, x.path);
        return rawURL.toString();
      });
      for (const rawURL of rawRquests) {
        try {
          const packageControl = await DebianPackage.getControl(await httpRequest.streamRequest({
            url: rawURL,
            headers: token ? { Authorization: `token ${token}` } : undefined
          }));
          await packageManeger.addPackage({
            dist: options.distName,
            component: repositoryFrom.componentName ?? branch,
            packageControl,
            repositoryFrom,
            restoreStream: {
              from: "url",
              url: rawURL
            }
          }).then(() => {
            if (options.callback) options.callback(null, packageControl);
          }).catch(err => {
            if (options.callback) options.callback(err, null);
            else throw err;
          });
        } catch (err) {
          if (options.callback) options.callback(err, null);
          else throw err;
        }
      }
    } else if (subType === "release") {
      const { tag } = repositoryFrom;
      try {
        let ghReleases = await (tag?.length > 0 ? Promise.all(tag.map(async releaseTag => gh.getRelease(releaseTag))).then(x => x.flat(3)) : gh.getRelease());
        ghReleases = ghReleases.filter(x => (x.assets = x.assets.filter(x => x.name.endsWith(".deb"))).length > 0);
        for (const { assets, tag_name } of ghReleases) {
          for (const { browser_download_url } of assets) {
            const packageControl = await DebianPackage.getControl(await httpRequest.streamRequest({
              url: browser_download_url,
              headers: token ? { Authorization: `token ${token}` } : undefined
            }));
            await packageManeger.addPackage({
              dist: options.distName,
              component: repositoryFrom.componentName ?? tag_name,
              packageControl,
              repositoryFrom,
              restoreStream: {
                from: "url",
                url: browser_download_url
              }
            }).then(() => {
              if (options.callback) options.callback(null, packageControl);
            }).catch(err => {
              if (options.callback) options.callback(err, null);
              else throw err;
            });
          }
        }
      } catch (err) {
        if (options.callback) options.callback(err, null);
        else throw err;
      }
    }
  } else if (repositoryFrom.type === "oracle_bucket") {
    const { region, bucket, namespace, auth, path: bucketPaths } = repositoryFrom;
    const oracleBucket = await coreUtils.oracleBucket(region as any, bucket, namespace, auth);
    const filesList = (await oracleBucket.fileList()).filter(x => bucketPaths?.length === 0 || bucketPaths.some(y => x.name.startsWith(y))).filter(x => x.name.endsWith(".deb"));
    for (const file of filesList) {
      try {
        const packageControl = await DebianPackage.getControl(await oracleBucket.getFileStream(file.name));
        await packageManeger.addPackage({
          dist: options.distName,
          component: repositoryFrom.componentName ?? "main",
          packageControl,
          repositoryFrom,
          restoreStream: {
            from: "file",
            filePath: file.name
          }
        }).then(() => {
          if (options.callback) options.callback(null, packageControl);
        }).catch(err => {
          if (options.callback) options.callback(err, null);
          else throw err;
        });
      } catch (err) {
        if (options.callback) options.callback(err, null);
        else throw err;
      }
    }
  } else if (repositoryFrom.type === "google_driver") {
    try {
      const { app, id } = repositoryFrom;
      if (!app.token) throw new Error("Google driver token is required");
      const googleDriver = await coreUtils.googleDriver({
        clientID: app.id,
        clientSecret: app.secret,
        token: app.token
      });
      let filesList = await (!id ? googleDriver.listFiles() : Promise.all(id.map(async id => googleDriver.listFiles(id))).then(x => x.flat(3)));
      filesList = filesList.filter(x => x.name.endsWith(".deb"));
      for (const file of filesList) {
        const packageControl = await DebianPackage.getControl(await googleDriver.getFileStream(file.id));
        await packageManeger.addPackage({
          dist: options.distName,
          component: repositoryFrom.componentName ?? "main",
          packageControl,
          repositoryFrom,
          restoreStream: {
            from: "google_driver",
            fileID: file.id
          }
        }).then(() => {
          if (options.callback) options.callback(null, packageControl);
        }).catch(err => {
          if (options.callback) options.callback(err, null);
          else throw err;
        });
      }
    } catch (err) {
      if (options.callback) options.callback(err, null);
      else throw err;
    }
  } else if (repositoryFrom.type === "docker") {
    console.info("docker disabled");
  } else if (repositoryFrom.type === "mirror") {
    const { url, dists } = repositoryFrom;
    const joinPath = (...paths: string[]) => {
      const distRoot = new URL(url);
      distRoot.pathname = path.posix.join(distRoot.pathname, ...paths);
      return distRoot.toString();
    }
    for (const mirrorName in dists) {
      try {
        const mirrorDists = dists[mirrorName];
        const inReleaseURL = joinPath("dists", mirrorName, "InRelease");
        const ReleaseURL = joinPath("dists", mirrorName, "Release");
        const releaseData = await DebianPackage.parseRelease(await httpRequest.bufferFetch(inReleaseURL).catch(() => httpRequest.bufferFetch(ReleaseURL)).then(async ({data: release}) => {
          if (release.subarray(0, 6).toString().startsWith("----")) {
            const decrypt = ((await openpgp.readCleartextMessage({cleartextMessage: release.toString()})).getText());
            return Buffer.from(decrypt, "utf8");
          }
          return release;
        }));
        if (!releaseData.Architectures) {
          const archs = releaseData.Architectures as string[];
          if (!mirrorDists.archs?.length) mirrorDists.archs = archs;
          else mirrorDists.archs = mirrorDists.archs.filter((arch) => archs.includes(arch));
        }
        if (!releaseData.Components) {
          const components = releaseData.Components as string[];
          if (!mirrorDists.components?.length) mirrorDists.components = components;
          else mirrorDists.components = mirrorDists.components.filter((component) => components.includes(component));
        }

        for (const component of mirrorDists.components) {
          for (const arch of mirrorDists.archs) {
            const packagesURL = joinPath("dists", mirrorName, component, "binary-" + arch, "Packages");
            const stream = await httpRequest.streamRequest(packagesURL).catch(() => httpRequest.streamRequest(packagesURL+".gz").then(stream => stream.pipe(zlib.createGunzip()))).catch(() => httpRequest.streamRequest(packagesURL+".xz").then(stream => stream.pipe(lzma.Decompressor()))).catch(err => console.log(err));
            if (!stream) continue;
            const comArchPackages = await DebianPackage.parsePackages(stream);
            for (const packageControl of comArchPackages) {
              const downloadURL = joinPath(packageControl.Filename);
              await packageManeger.addPackage({
                dist: options.distName,
                component: repositoryFrom.componentName ?? component,
                packageControl,
                repositoryFrom,
                restoreStream: {
                  from: "url",
                  url: downloadURL
                }
              }).then(() => {
                if (options.callback) options.callback(null, packageControl);
              }).catch(err => {
                if (options.callback) options.callback(err, null);
                else throw err;
              });
            }
          }
        }
      } catch (err) {
        if (options.callback) options.callback(err, null);
        else throw err;
      }
    }
  } else console.warn("Invalid config (%s)", JSON.stringify(repositoryFrom));
}
