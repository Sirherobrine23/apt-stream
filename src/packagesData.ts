import coreUtils, { DebianPackage, DockerRegistry, extendFs, httpRequest, httpRequestGithub } from "@sirherobrine23/coreutils";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { MongoClient, ServerApiVersion, Filter } from "mongodb";
import { apt_config, backendConfig, repository } from "./repoConfig.js";
import { getPackages as mirror } from "./mirror.js";
import { Readable } from "node:stream";
import { format } from "node:util";
import cluster from "node:cluster";
import path from "node:path";
import tar from "tar";

export type packageSave = {
  dist: string,
  suite: string,
  repository: repository,
  aptConfig?: apt_config,
  control: DebianPackage.debianControl,
  restoreFileStream?: {
    from: repository["from"],
    [key: string]: any,
  },
  getFileStream: () => Promise<Readable>,
};

export type packageManegerV2 = {
  loadRepository: (distName: string, repo: repository, packageAptConfig?: apt_config, aptConfig?: backendConfig) => Promise<any>,
  getPackages: (dist?: string, suite?: string, Package?: string, Arch?: string, Version?: string) => Promise<packageSave[]>,
  deletePackage: (repo: Partial<packageSave>) => Promise<packageSave>,
  addPackage: (repo: packageSave) => Promise<void>,
  existsDist: (dist: string) => Promise<boolean>,
  existsSuite: (dist: string, suite: string) => Promise<boolean>,
  getDists: () => Promise<string[]>,
  getDistInfo: (dist: string) => Promise<{
    packagesCount: number,
    arch: string[],
    packagesName: string[],
    suites: string[],
  }>,
};

/**
 * Maneger and Load packages to Database or internal object (Nodejs Heap Memory, if large data use Database)
 * @returns
 */
export default async function packageManeger(config: backendConfig): Promise<packageManegerV2> {
  const partialConfig: Partial<packageManegerV2> = {};

  if (config["apt-config"]?.mongodb) {
    // Connect to database
    const mongoConfig = config["apt-config"].mongodb;
    const mongoClient = await (new MongoClient(mongoConfig.uri, {serverApi: ServerApiVersion.v1})).connect();
    const collection = mongoClient.db(mongoConfig.db ?? "aptStream").collection<packageSave>(mongoConfig.collection ?? "packagesData");

    // Drop collection
    if (cluster.isPrimary) {
      if (mongoConfig.dropCollention && await collection.findOne()) {
        await collection.drop();
        console.log("Drop collection: %s", mongoConfig.collection ?? "packagesData");
      }
    }

    partialConfig.addPackage = async function addPackage(repo) {
      const existsPackage = await collection.findOne({dist: repo.dist, suite: repo.suite, "control.Package": repo.control.Package, "control.Version": repo.control.Version, "control.Architecture": repo.control.Architecture});
      if (existsPackage) throw new Error(format("Package (%s/%s: %s) already exists!", repo.control.Package, repo.control.Version, repo.control.Architecture));
      await collection.insertOne(repo);
      console.log("Added '%s', version: %s, Arch: %s, in to %s/%s", repo.control.Package, repo.control.Version, repo.control.Architecture, repo.dist, repo.suite);
    }

    partialConfig.deletePackage = async function deletePackage(repo) {
      const packageDelete = (await collection.findOneAndDelete({dist: repo.dist, suite: repo.suite, "control.Package": repo.control.Package, "control.Version": repo.control.Version, "control.Architecture": repo.control.Architecture}))?.value;
      if (!packageDelete) throw new Error("Package not found!");
      console.info("Deleted '%s', version: %s, Arch: %s, from %s/%s", packageDelete.control.Package, packageDelete.control.Version, packageDelete.control.Architecture, packageDelete.dist, packageDelete.suite);
      return packageDelete;
    }

    partialConfig.existsDist = async function existsDist(dist) {
      return (await collection.findOne({dist})) ? true : false;
    }

    partialConfig.existsSuite = async function existsSuite(dist, suite) {
      return (await collection.findOne({dist, suite})) ? true : false;
    }

    partialConfig.getDists = async function getDists() {
      return collection.distinct("dist");
    }

    partialConfig.getDistInfo = async function getDistInfo(dist) {
      const packages = await collection.find({dist}).toArray();
      if (!packages.length) throw new Error("Dist not found!");
      return {
        packagesCount: packages.length,
        arch: [...new Set(packages.map((p) => p.control.Architecture))],
        packagesName: [...new Set(packages.map((p) => p.control.Package))],
        suites: [...new Set(packages.map((p) => p.suite))]
      };
    }

    // Packages
    function fixPackage(data: packageSave): packageSave {
      if (!data.restoreFileStream) throw new Error("cannot restore file stream!");
      data.getFileStream = async function getFileStream() {
        if (data.restoreFileStream.fileUrl) return coreUtils.httpRequest.pipeFetch(data.restoreFileStream.fileUrl);
        if (data.restoreFileStream.from === "google_drive" && data.repository.from === "google_drive") {
          const { appSettings } = data.repository;
          const googleDrive = await coreUtils.googleDriver.GoogleDriver(appSettings.client_id, appSettings.client_secret, {token: appSettings.token});
          return googleDrive.getFileStream(data.restoreFileStream.fileId);
        } else if (data.restoreFileStream.from === "oci" && data.repository.from === "oci") {
          const oci = await coreUtils.DockerRegistry(data.repository.image);
          return new Promise((done, reject) => {
            oci.blobLayerStream(data.restoreFileStream.digest).then((stream) => {
              stream.pipe(tar.list({
                filter: (path) => path === data.restoreFileStream.fileName,
                onentry: (entry) => done(entry as any)
              }))
            }).catch(reject);
          });
        }
        throw new Error("Cannot restore file stream!");
      }
      return data;
    }
    partialConfig.getPackages = async function getPackages(dist, suite, Package, Arch, Version) {
      const doc: Filter<packageSave> = {};
      if (dist) {
        if (!await partialConfig.existsDist(dist)) throw new Error("Distribution not found!");
        doc.dist = dist;
      }
      if (suite) {
        if (!await partialConfig.existsSuite(dist, suite)) throw new Error("Suite/Component not found!");
        doc.suite = suite;
      }
      if (Package) doc["control.Package"] = Package;
      if (Arch) doc["control.Architecture"] = Arch;
      if (Version) doc["control.Version"] = Version;
      const packageInfo = await collection.find(doc).toArray();
      if (!packageInfo) throw new Error("Package not found!");
      return packageInfo.map(fixPackage);
    }
  } else {
    // Internal Object
    let packagesArray: packageSave[] = [];

    // Add package to array
    partialConfig.addPackage = async function addPackage(repo) {
      const existsPackage = packagesArray.find((x) => x.control.Package === repo.control.Package && x.control.Version === repo.control.Version && x.control.Architecture === repo.control.Architecture && x.dist === repo.dist && x.suite === repo.suite && x.repository === repo.repository);
      if (existsPackage) throw new Error("Package already exists!");
      packagesArray.push(repo);
      console.log("Added '%s', version: %s, Arch: %s, in to %s/%s", repo.control.Package, repo.control.Version, repo.control.Architecture, repo.dist, repo.suite);
    }

    // Delete package
    partialConfig.deletePackage = async function deletePackage(repo) {
      const index = packagesArray.findIndex((x) => x.control.Package === repo.control.Package && x.control.Version === repo.control.Version && x.control.Architecture === repo.control.Architecture && x.dist === repo.dist && x.suite === repo.suite && x.repository === repo.repository);
      if (index === -1) throw new Error("Package not found!");
      const packageDelete = packagesArray.splice(index, 1).at(-1);
      console.info("Deleted '%s', version: %s, Arch: %s, from %s/%s", packageDelete.control.Package, packageDelete.control.Version, packageDelete.control.Architecture, packageDelete.dist, packageDelete.suite);
      return packageDelete;
    }

    // Exists
    partialConfig.existsDist = async function existsDist(dist) {
      return packagesArray.find(x => x.dist === dist) ? true : false;
    }
    partialConfig.existsSuite = async function existsSuite(dist, suite) {
      if (await partialConfig.existsDist(dist)) return packagesArray.find(x => x.dist === dist && x.suite === suite) ? true : false;
      return false;
    }

    // Packages
    partialConfig.getPackages = async function getPackages(dist, suite, Package, Arch, Version) {
      if (dist && !await partialConfig.existsDist(dist)) throw new Error("Distribution not found!");
      if (suite && !await partialConfig.existsSuite(dist, suite)) throw new Error("Suite/Component not found!");
      const packageInfo = packagesArray.filter(x => (!dist || x.dist === dist) && (!suite || x.suite === suite) && (!Package || x.control.Package === Package) && (!Arch || x.control.Architecture === Arch) && (!Version || x.control.Version === Version));
      if (!packageInfo.length) throw new Error("Package not found!");
      return packageInfo;
    }
  }

  if (!partialConfig.getDists) partialConfig.getDists = async function getDists() {
    const packages = await partialConfig.getPackages();
    return [...new Set(packages.map(U => U.dist))];
  }

  if (!partialConfig.getDistInfo) partialConfig.getDistInfo = async function getDistInfo(dist: string) {
    const packages = await partialConfig.getPackages(dist);
    return {
      packagesCount: packages.length,
      packagesName: [...new Set(packages.map(U => U.control.Package))],
      arch: [...new Set(packages.map(U => U.control.Architecture))],
      suites: [...new Set(packages.map(U => U.suite))],
    };
  }

  partialConfig.loadRepository = async function loadRepository(distName: string, repository: repository, packageAptConfig?: apt_config, aptConfig?: backendConfig) {
    const saveFile = aptConfig["apt-config"]?.saveFiles ?? false;
    const rootPool = aptConfig["apt-config"]?.poolPath ?? path.join(process.cwd(), "pool");
    if (repository.from === "mirror") {
      // Ingore fast load data for low ram memory
      for (const repoDistName in repository.dists) {
        const distInfo = repository.dists[repoDistName];
        const packagesData: Awaited<ReturnType<typeof mirror>> = [];
        if (!distInfo.suites) await mirror(repository.uri, {dist: distName}).then(U => packagesData.push(...U));
        else for (const suite of distInfo.suites) await mirror(repository.uri, {dist: repoDistName, suite}).then(U => packagesData.push(...U));
        const partialPromises = packagesData.map(({Package: control}) => {
          const filePool = path.join(rootPool, control.Package.slice(0, 1), `${control.Package}_${control.Architecture}_${control.Version}.deb`);
          const getStream = async () => {
            if (saveFile && await extendFs.exists(filePool)) return createReadStream(filePool);
            if (saveFile) {
              const mainPath = path.resolve(filePool, "..");
              if (!await extendFs.exists(mainPath)) await fs.mkdir(mainPath, {recursive: true});
              const fileStream = await httpRequest.pipeFetch(control.Filename);
              fileStream.pipe(createWriteStream(filePool));
              return fileStream;
            }
            return httpRequest.pipeFetch(control.Filename);
          }
          return partialConfig.addPackage({
            dist: distName,
            suite: repository.suite ?? "main",
            repository: repository,
            control,
            aptConfig: packageAptConfig ?? aptConfig["apt-config"],
            getFileStream: getStream,
            restoreFileStream: {
              from: "mirror",
              fileUrl: control.Filename,
            }
          }).catch(err => err);
        });

        return Promise.all(partialPromises);
      }
    } else if (repository.from === "oci") {
      const registry = await DockerRegistry.Manifest.Manifest(repository.image, repository.platfom_target);
      return registry.layersStream((data) => {
        if (!(["gzip", "gz", "tar"]).some(ends => data.layer.mediaType.endsWith(ends))) return data.next();
        data.stream.pipe(tar.list({
          async onentry(entry) {
            if (!entry.path.endsWith(".deb")) return null;
            const control = await DebianPackage.extractControl(entry as any);
            const suite = repository.suite ?? "main";
            async function getStream() {
              const filePool = path.join(rootPool, control.Package.slice(0, 1), `${control.Package}_${control.Architecture}_${control.Version}.deb`);
              if (saveFile && await extendFs.exists(filePool)) return createReadStream(filePool);
              return new Promise<Readable>((done, reject) => registry.blobLayerStream(data.layer.digest).then(stream => {
                stream.on("error", reject);
                stream.pipe(tar.list({
                  async onentry(getEntry) {
                    if (getEntry.path !== entry.path) return null;
                    if (saveFile) {
                      const mainPath = path.resolve(filePool, "..");
                      if (!await extendFs.exists(mainPath)) await fs.mkdir(mainPath, {recursive: true});
                      entry.pipe(createWriteStream(filePool));
                    }
                    return done(getEntry as any);
                  }
                // @ts-ignore
                }).on("error", reject));
              }).catch(reject));
            }
            return partialConfig.addPackage({
              dist: distName,
              suite,
              repository: repository,
              control,
              aptConfig: packageAptConfig ?? aptConfig["apt-config"],
              getFileStream: getStream,
              restoreFileStream: {
                from: "oci",
                digest: data.layer.digest,
                path: entry.path,
              }
            });
          }
        }));
      });
    } else if (repository.from === "github_release") {
      if (repository.tags) {
        const release = await Promise.all(repository.tags.map(async releaseTag => httpRequestGithub.getRelease({
          owner: repository.owner,
          repository: repository.repository,
          token: repository.token,
          releaseTag,
        })));
        return Promise.all(release.map(async release => Promise.all(release.assets.map(async ({browser_download_url, name}) => {
          if (!name.endsWith(".deb")) return null;
          const control = await DebianPackage.extractControl(await httpRequest.pipeFetch(browser_download_url));
          const filePool = path.join(rootPool, control.Package.slice(0, 1), `${control.Package}_${control.Architecture}_${control.Version}.deb`);
          const getStream = async () => {
            if (saveFile && await extendFs.exists(filePool)) return createReadStream(filePool);
            if (saveFile) {
              const mainPath = path.resolve(filePool, "..");
              if (!await extendFs.exists(mainPath)) await fs.mkdir(mainPath, {recursive: true});
              const fileStream = await httpRequest.pipeFetch(browser_download_url);
              fileStream.pipe(createWriteStream(filePool));
              return fileStream;
            }
            return httpRequest.pipeFetch(browser_download_url);
          }
          return partialConfig.addPackage({
            dist: distName,
            suite: repository.suite ?? "main",
            repository: repository,
            control,
            aptConfig: packageAptConfig ?? aptConfig["apt-config"],
            getFileStream: getStream,
            restoreFileStream: {
              from: "github_release",
              fileUrl: browser_download_url,
            }
          }).catch(err => {});
        })))).then(data => data.flat(2).filter(Boolean));
      }
      const release = await httpRequestGithub.getRelease({owner: repository.owner, repository: repository.repository, token: repository.token, peer: repository.assetsLimit, all: false});
      return Promise.all(release.map(async release => Promise.all(release.assets.map(async ({browser_download_url, name}) => {
        if (!name.endsWith(".deb")) return null;
        const control = await DebianPackage.extractControl(await httpRequest.pipeFetch(browser_download_url));
        const filePool = path.join(rootPool, control.Package.slice(0, 1), `${control.Package}_${control.Architecture}_${control.Version}.deb`);
        const getStream = async () => {
          if (saveFile && await extendFs.exists(filePool)) return createReadStream(filePool);
          if (saveFile) {
            const mainPath = path.resolve(filePool, "..");
            if (!await extendFs.exists(mainPath)) await fs.mkdir(mainPath, {recursive: true});
            const fileStream = await httpRequest.pipeFetch(browser_download_url);
            fileStream.pipe(createWriteStream(filePool));
            return fileStream;
          }
          return httpRequest.pipeFetch(browser_download_url);
        }
        return partialConfig.addPackage({
          dist: distName,
          suite: repository.suite ?? "main",
          repository: repository,
          control,
          aptConfig: packageAptConfig ?? aptConfig["apt-config"],
          getFileStream: getStream,
          restoreFileStream: {
            from: "github_release",
            fileUrl: browser_download_url,
          }
        }).catch(err => {});
      })))).then(data => data.flat(2).filter(Boolean));
    } else if (repository.from === "github_tree") {
      const { tree } = await httpRequestGithub.githubTree(repository.owner, repository.repository, repository.tree);
      const filtedTree = tree.filter(({path: remotePath}) => {
        if (repository.path) return repository.path.some(repoPath => {
          if (!remotePath.startsWith("/")) remotePath = "/" + remotePath;
          if (typeof repoPath === "string") {
            if (!repoPath.startsWith("/")) repoPath = "/" + repoPath;
            return remotePath.startsWith(repoPath);
          }
          return false;
        });
        return true;
      }).filter(({path, type}) => path.endsWith(".deb") && type === "blob");
      return Promise.all(filtedTree.map(async ({path: filePath}) => {
        const downloadUrl = `https://raw.githubusercontent.com/${repository.owner}/${repository.repository}/${repository.tree}/${filePath}`;
        const control = await DebianPackage.extractControl(await httpRequest.pipeFetch(downloadUrl));
        const filePool = path.join(rootPool, control.Package.slice(0, 1), `${control.Package}_${control.Architecture}_${control.Version}.deb`);
        const getStream = async () => {
          if (saveFile && await extendFs.exists(filePool)) return createReadStream(filePool);
          if (saveFile) {
            const mainPath = path.resolve(filePool, "..");
            if (!await extendFs.exists(mainPath)) await fs.mkdir(mainPath, {recursive: true});
            const fileStream = await httpRequest.pipeFetch(downloadUrl);
            fileStream.pipe(createWriteStream(filePool));
            return fileStream;
          }
          return httpRequest.pipeFetch(downloadUrl);
        }
        return partialConfig.addPackage({
          dist: distName,
          suite: repository.suite ?? "main",
          repository: repository,
          control,
          aptConfig: packageAptConfig ?? aptConfig["apt-config"],
          getFileStream: getStream,
          restoreFileStream: {
            from: "github_tree",
            fileUrl: downloadUrl,
          }
        }).catch(err => {});
      }));
    } else if (repository.from === "google_drive") {
      const client_id = repository.appSettings.client_id;
      const client_secret = repository.appSettings.client_secret;
      const token = repository.appSettings.token;
      const googleDriver = await coreUtils.googleDriver.GoogleDriver(client_id, client_secret, {
        token,
        async authCallback(url, token) {
          if (url) console.log("Please visit this url to auth google driver: %s", url);
          else console.log("Google driver auth success, please save token to config file, token: %s", token);
        },
      });
      const files = (repository.folderId ? (await Promise.all(repository.folderId.map(async folderId => await googleDriver.listFiles(folderId)))).flat() : await googleDriver.listFiles());
      return Promise.all(files.filter(({name, isTrashedFile}) => !isTrashedFile && name.endsWith(".deb")).map(async fileData => {
        const control = await DebianPackage.extractControl(await googleDriver.getFileStream(fileData.id));
        const filePool = path.join(rootPool, control.Package.slice(0, 1), `${control.Package}_${control.Architecture}_${control.Version}.deb`);
        const getStream = async () => {
          if (saveFile && await extendFs.exists(filePool)) return createReadStream(filePool);
          if (saveFile) {
            const mainPath = path.resolve(filePool, "..");
            if (!await extendFs.exists(mainPath)) await fs.mkdir(mainPath, {recursive: true});
            const fileStream = await googleDriver.getFileStream(fileData.id);
            fileStream.pipe(createWriteStream(filePool));
            return fileStream;
          }
          return googleDriver.getFileStream(fileData.id);
        }
        return partialConfig.addPackage({
          dist: distName,
          suite: repository.suite ?? "main",
          repository: repository,
          control,
          aptConfig: packageAptConfig ?? aptConfig["apt-config"],
          getFileStream: getStream,
          restoreFileStream: {
            from: "google_drive",
            fileId: fileData.id,
          }
        }).catch(err => {});
      }));
    } else if (repository.from === "oracle_bucket") {
      const oracleBucket = await coreUtils.oracleBucket(repository.region as any, repository.bucketName, repository.bucketNamespace, repository.auth);
      return Promise.all((await oracleBucket.fileList()).filter(({name}) => name.endsWith(".deb")).map(async fileData => {
        const control = await DebianPackage.extractControl(await oracleBucket.getFileStream(fileData.name));
        const filePool = path.join(rootPool, control.Package.slice(0, 1), `${control.Package}_${control.Architecture}_${control.Version}.deb`);
        const getStream = async () => {
          if (saveFile && await extendFs.exists(filePool)) return createReadStream(filePool);
          if (saveFile) {
            const mainPath = path.resolve(filePool, "..");
            if (!await extendFs.exists(mainPath)) await fs.mkdir(mainPath, {recursive: true});
            const fileStream = await oracleBucket.getFileStream(fileData.name);
            fileStream.pipe(createWriteStream(filePool));
            return fileStream;
          }
          return oracleBucket.getFileStream(fileData.name);
        }
        return partialConfig.addPackage({
          dist: distName,
          suite: repository.suite ?? "main",
          repository: repository,
          control,
          aptConfig: packageAptConfig ?? aptConfig["apt-config"],
          getFileStream: getStream,
          restoreFileStream: {
            from: "oracle_bucket",
            fileName: fileData.name,
          }
        }).catch(err => {});
      }));
    }

    throw new Error(`Unknown repository from: ${(repository as any)?.from ?? "undefined"}`);
  }

  // Return functions
  return partialConfig as packageManegerV2;
}