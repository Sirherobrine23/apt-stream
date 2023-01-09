import coreUtils, { DebianPackage, httpRequestGithub, httpRequest, DockerRegistry, extendFs } from "@sirherobrine23/coreutils";
import { getConfig, distManegerPackages } from "./repoConfig.js";
import { createReadStream, createWriteStream, watchFile, promises as fs } from "node:fs";
import { getPackages } from "./mirror.js";
import { Readable } from "node:stream";
import { CronJob } from "cron";
import { format } from "node:util";
import express from "express";
import openpgp from "openpgp";
import tar from "tar";
import path from "node:path";

export default async function main(configPath: string) {
  // Load config
  const packInfos = new distManegerPackages()
  let repositoryConfig = await getConfig(configPath);

  // Express app
  const app = express();
  app.disable("x-powered-by").disable("etag").use(express.json()).use(express.urlencoded({ extended: true })).use((req, res, next) => {
    res.json = (data) => res.setHeader("Content-Type", "application/json").send(JSON.stringify(data, null, 2));
    const requestInitial = Date.now();
    console.log("[%s]: Method: %s, From: %s, Path %s", requestInitial, req.method, req.ip, req.path);
    res.once("close", () => console.log("[%s]: Method: %s, From: %s, Path %s, Status: %s, Time: %sms", Date.now(), req.method, req.ip, req.path, res.statusCode, Date.now() - requestInitial));
    next();
  });

  // Public key
  app.get(["/public_key", "/public.gpg"], async ({res}) => {
    const Key = repositoryConfig["apt-config"]?.pgpKey;
    if (!Key) return res.status(400).json({error: "This repository no sign Packages files"});
    const pubKey = (await openpgp.readKey({ armoredKey: Key.public })).armor();
    return res.setHeader("Content-Type", "application/pgp-keys").send(pubKey);
  });

  // Sources list
  app.get(["/source_list", "/sources.list"], (req, res) => {
    const remotePath = path.posix.resolve(req.baseUrl + req.path, ".."),
      protocol = req.headers["x-forwarded-proto"] ?? req.protocol,
      hostname = req.hostname,
      host = repositoryConfig["apt-config"]?.sourcesHost ?? `${protocol}://${hostname}:${req.socket.localPort}${remotePath}`,
      concatPackage = packInfos.getAllDistribuitions(),
      type = req.query.type ?? req.query.t,
      Conflicting = !!(req.query.conflicting ?? req.query.c);
    if (type === "json") {
      return res.json({
        host,
        distribuitions: concatPackage
      });
    } else if (type === "deb822") {}
    let sourcesList = "";
    concatPackage.forEach((dist) => sourcesList += format("deb %s %s %s\n", host, (Conflicting ? "./" : "")+dist.dist, dist.suites.join(" ")));
    return res.status(200).setHeader("Content-Type", "text/plain").send(sourcesList);
  });

  // Download
  app.get(["/pool", "/"], (_req, res) => res.json(packInfos.getAllDistribuitions()));
  app.get("/pool/:dist", (req, res) => res.json(packInfos.getDistribuition(req.params.dist)));
  app.get("/pool/:dist/:suite", ({params: {dist, suite}}, res) => res.json(packInfos.getPackageInfo({dist, suite})));
  app.get("/pool/:dist/:suite/:arch", ({params: {dist, suite, arch}}, res) => res.json(packInfos.getPackageInfo({dist, suite, arch})));
  app.get("/pool/:dist/:suite/:arch/:packageName", ({params: {dist, suite, arch, packageName}}, res) => res.json(packInfos.getPackageInfo({dist, suite, arch, packageName})));
  app.get("/pool/:dist/:suite/:arch/:packageName/:version", ({params: {dist, suite, arch, packageName, version}}, res) => res.json(packInfos.getPackageInfo({dist, suite, arch, packageName, version})));
  app.get("/pool/:dist/:suite/:arch/:packageName/:version/download.deb", async ({params: {dist, suite, arch, packageName, version}}, res, next) => packInfos.getPackageStream(dist, suite, arch, packageName, version).then(data => data.stream.pipe(res.writeHead(200, {"Content-Type": "application/x-debian-package", "Content-Length": data.control.Size, "Content-Disposition": `attachment; filename="${packageName}_${version}_${arch}.deb"`, "SHA256_hash": data.control.SHA256, "MD5Sum_hash": data.control.MD5sum}))).catch(next));

  app.get("/dists/(./)?:dist/:suite/binary-:arch/Packages(.(xz|gz)|)", (req, res) => {
    if (req.path.endsWith(".gz")) {
      packInfos.createPackages({
        compress: "gzip",
        dist: req.params.dist,
        arch: req.params.arch,
        suite: req.params.suite,
        writeStream: res.writeHead(200, {
          "Content-Encoding": "gzip",
          "Content-Type": "application/x-gzip"
        }),
      });
    } else if (req.path.endsWith(".xz")) {
      packInfos.createPackages({
        compress: "xz",
        dist: req.params.dist,
        arch: req.params.arch,
        suite: req.params.suite,
        writeStream: res.writeHead(200, {
          "Content-Encoding": "xz",
          "Content-Type": "application/x-xz"
        }),
      });
    } else {
      packInfos.createPackages({
        dist: req.params.dist,
        arch: req.params.arch,
        suite: req.params.suite,
        writeStream: res.writeHead(200, {
          "Content-Type": "text/plain"
        }),
      });
    }
  });

  // Release
  async function createReleaseV1(dist: string) {
    const { suites, archs } = packInfos.getDistribuition(dist);
    const distConfig = repositoryConfig.repositories[dist];
    if (!distConfig) throw new Error("Dist not found");
    const ReleaseLines = [];

    // Origin
    const Origin = distConfig["apt-config"]?.origin ?? repositoryConfig["apt-config"]?.origin;
    if (Origin) ReleaseLines.push(`Origin: ${Origin}`);

    // Lebel
    const Label = distConfig["apt-config"]?.label ?? repositoryConfig["apt-config"]?.label;
    if (Label) ReleaseLines.push(`Label: ${Label}`);

    // Codename if exists
    const codename = distConfig["apt-config"]?.codename ?? repositoryConfig["apt-config"]?.codename;
    if (codename) ReleaseLines.push(`Codename: ${codename}`);

    // Date
    ReleaseLines.push(`Date: ${new Date().toUTCString()}`);

    // Architectures
    if (archs.length === 0) throw new Error("No architectures found");
    ReleaseLines.push(`Architectures: ${archs.join(" ")}`);

    // Components
    if (suites.length === 0) throw new Error("No suites found");
    ReleaseLines.push(`Components: ${suites.join(" ")}`);

    const createPackagesHash = distConfig["apt-config"]?.enableHash ?? repositoryConfig["apt-config"]?.enableHash ?? true;
    if (createPackagesHash) {
      ReleaseLines.push("Acquire-By-Hash: yes");
      const hashs = (await Promise.all(archs.map(async arch => Promise.all(suites.map(async suite => {
        const [gzip, xz, raw] = await Promise.all([packInfos.createPackages({compress: "gzip", dist, arch, suite}), packInfos.createPackages({compress: "xz", dist, arch, suite}), packInfos.createPackages({dist, arch, suite})]);
        return {
          gz: {
            sha256: {
              file: `${suite}/binary-${arch}/Packages.gz`,
              size: gzip.size,
              hash: gzip.sha256
            },
            sha1: {
              file: `${suite}/binary-${arch}/Packages.gz`,
              size: gzip.size,
              hash: gzip.sha1
            },
            md5: {
              file: `${suite}/binary-${arch}/Packages.gz`,
              size: gzip.size,
              hash: gzip.md5
            }
          },
          xz: {
            sha256: {
              file: `${suite}/binary-${arch}/Packages.xz`,
              size: xz.size,
              hash: xz.sha256
            },
            sha1: {
              file: `${suite}/binary-${arch}/Packages.xz`,
              size: xz.size,
              hash: xz.sha1
            },
            md5: {
              file: `${suite}/binary-${arch}/Packages.xz`,
              size: xz.size,
              hash: xz.md5
            }
          },
          raw: {
            sha256: {
              file: `${suite}/binary-${arch}/Packages`,
              size: raw.size,
              hash: raw.sha256
            },
            sha1: {
              file: `${suite}/binary-${arch}/Packages`,
              size: raw.size,
              hash: raw.sha1
            },
            md5: {
              file: `${suite}/binary-${arch}/Packages`,
              size: raw.size,
              hash: raw.md5
            }
          }
        };
      }))))).flat(2);

      const sha256 = hashs.map(hash => hash.raw.sha256).concat(hashs.map(hash => hash.gz.sha256)).concat(hashs.map(hash => hash.xz.sha256));
      if (sha256.length > 0) ReleaseLines.push(`SHA256:${sha256.sort().map((hash) => `\n  ${hash.hash} ${hash.size} ${hash.file}`).join("")}`);

      const sha1 = hashs.map(hash => hash.raw.sha1).concat(hashs.map(hash => hash.gz.sha1)).concat(hashs.map(hash => hash.xz.sha1));
      if (sha1.length > 0) ReleaseLines.push(`SHA1:${sha1.sort().map((hash) => `\n  ${hash.hash} ${hash.size} ${hash.file}`).join("")}`);

      const md5 = hashs.map(hash => hash.raw.md5).concat(hashs.map(hash => hash.gz.md5)).concat(hashs.map(hash => hash.xz.md5));
      if (md5.length > 0) ReleaseLines.push(`MD5Sum:${md5.sort().map((hash) => `\n  ${hash.hash} ${hash.size} ${hash.file}`).join("")}`);
    }

    return ReleaseLines.join("\n");
  }
  app.get("/dists/(./)?:dist/Release", (req, res, next) => createReleaseV1(req.params.dist).then((data) => res.setHeader("Content-Type", "text/plain").send(data)).catch(next));
  app.get("/dists/(./)?:dist/InRelease", (req, res, next) => {
    const Key = repositoryConfig["apt-config"]?.pgpKey;
    if (!Key) return res.status(404).json({error: "No PGP key found"});
    return Promise.resolve().then(async () => {
      const privateKey = Key.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: Key.private }), passphrase: Key.passphrase}) : await openpgp.readPrivateKey({ armoredKey: Key.private });
      const Release = await createReleaseV1(req.params.dist);
      return res.setHeader("Content-Type", "text/plain").send(await openpgp.sign({
        signingKeys: privateKey,
        format: "armored",
        message: await openpgp.createCleartextMessage({text: Release}),
      }));
    }).catch(next);
  });
  app.get("/dists/(./)?:dist/Release.gpg", (req, res, next) => {
    const Key = repositoryConfig["apt-config"]?.pgpKey;
    if (!Key) return res.status(404).json({error: "No PGP key found"});
    return Promise.resolve().then(async () => {
      const privateKey = Key.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: Key.private }), passphrase: Key.passphrase}) : await openpgp.readPrivateKey({ armoredKey: Key.private });
      const Release = await createReleaseV1(req.params.dist);
      return res.setHeader("Content-Type", "text/plain").send(await openpgp.sign({
        signingKeys: privateKey,
        message: await openpgp.createMessage({text: Release}),
      }));
    }).catch(next);
  });

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({error: "Not found"});
  });

  // Error handler
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({
      error: err?.message||err,
      stack: err?.stack?.split("\n"),
    });
  });

  // Listen HTTP server
  const port = process.env.PORT ?? repositoryConfig["apt-config"].portListen ?? 0;
  app.listen(port, function () {return console.log(`apt-repo listening at http://localhost:${this.address().port}`);});

  // Loading and update packages
  let cronJobs: CronJob[] = [];
  const waitPromises: Promise<void>[] = [];
  const saveFile = repositoryConfig["apt-config"]?.saveFiles;
  const rootPool = repositoryConfig["apt-config"]?.poolPath;
  for (const dist in repositoryConfig.repositories) {
    const targets = repositoryConfig.repositories[dist].targets;
    for (const repository of targets) {
      const update = async () => {
        if (repository.from === "mirror") {
          return Promise.all(Object.keys(repository.dists).map(async distName => {
            const distInfo = repository.dists[distName];
            const packagesData = distInfo.suites ? await Promise.all(distInfo.suites.map(async suite => getPackages(repository.uri, {dist: distName, suite}))).then(U => U.flat()) : await getPackages(repository.uri, {dist: distName});
            return packagesData.forEach(({Package: control}) => {
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
              return packInfos.addPackage(dist, repository.suite ?? "main", {repositoryConfig: repository, control, getStream});
            });
          }));
        } else if (repository.from === "oci") {
          const registry = await DockerRegistry.Manifest.Manifest(repository.image, repository.platfom_target);
          return registry.layersStream((data) => {
            if (!(["gzip", "gz", "tar"]).some(ends => data.layer.mediaType.endsWith(ends))) return data.next();
            data.stream.pipe(tar.list({
              async onentry(entry) {
                if (!entry.path.endsWith(".deb")) return null;
                const control = await DebianPackage.extractControl(entry as any);
                const suite = repository.suite ?? "main";
                packInfos.addPackage(dist, suite, {
                  repositoryConfig: repository,
                  control,
                  async getStream() {
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
              return packInfos.addPackage(dist, repository.suite ?? release.tag_name, {repositoryConfig: repository, control, getStream});
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
            return packInfos.addPackage(dist, repository.suite ?? release.tag_name, {repositoryConfig: repository, control, getStream});
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
            return packInfos.addPackage(dist, repository.suite ?? "main", {repositoryConfig: repository, control, getStream});
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
            return packInfos.addPackage(dist, repository.suite ?? "main", {repositoryConfig: repository, control, getStream});
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
            return packInfos.addPackage(dist, repository.suite ?? "main", {repositoryConfig: repository, control, getStream});
          }));
        }
        return null;
      }
      waitPromises.push(update().then(() => {
        const cron = (repository.cronRefresh ?? []).map((cron) => new CronJob(cron, update));
        cron.forEach((cron) => cron.start());
        cronJobs.push(...cron);
      }).catch(console.error));
    }
  }
  // watch config file changes
  watchFile(configPath, async () => {
    console.info("Config file changed, reloading config and update packages...");
    repositoryConfig = await getConfig(configPath);
    cronJobs.forEach((cron) => cron.stop());
    cronJobs = [];
  });
  // await Promise.all(waitPromises);
  return app;
}
