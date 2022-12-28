import { DebianPackage, httpRequestGithub, httpRequest, DockerRegistry } from "@sirherobrine23/coreutils";
import { getConfig, distManegerPackages } from "./repoConfig.js";
import { Readable } from "node:stream";
import { CronJob } from "cron";
import { watchFile } from "node:fs";
import express from "express";
import openpgp from "openpgp";
import tar from "tar";
import { format } from "node:util";
import path from "node:path";

export default async function main(configPath: string) {
  const packInfos = new distManegerPackages()
  let repositoryConfig = await getConfig(configPath);
  const app = express();
  app.disable("x-powered-by").disable("etag").use(express.json()).use(express.urlencoded({ extended: true })).use((req, res, next) => {
    res.json = (data) => res.setHeader("Content-Type", "application/json").send(JSON.stringify(data, null, 2));
    next();
    const requestInitial = Date.now();
    console.log("[%s]: Method: %s, From: %s, Path %s", requestInitial, req.method, req.ip, req.path);
    res.once("close", () => console.log("[%s]: Method: %s, From: %s, Path %s, Status: %s, Time: %sms", Date.now(), req.method, req.ip, req.path, res.statusCode, Date.now() - requestInitial));
  });

  // Public key
  app.get("/public_key", async ({res}) => {
    const Key = repositoryConfig["apt-config"]?.pgpKey;
    if (!Key) return res.status(400).json({error: "This repository no sign Packages files"});
    const pubKey = (await openpgp.readKey({ armoredKey: Key.public })).armor();
    return res.setHeader("Content-Type", "application/pgp-keys").send(pubKey);
  });

  // Sources list
  app.get(["/source_list", "/sources.list"], (req, res) => {
    const remotePath = path.posix.resolve(req.baseUrl + req.path, "..");
    const host = repositoryConfig["apt-config"]?.sourcesHost ?? `${req.protocol}://${req.hostname}:${req.socket.localPort}${remotePath}`;
    const concatPackage = packInfos.getAllDistribuitions();
    const type = req.query.type ?? req.query.t;
    const Conflicting = !!(req.query.conflicting ?? req.query.c);
    if (type === "deb822") {
      const data = concatPackage.map(({distribuition, suitesName: suites}) => format("Types: deb\nURIs: %s\nSuites: %s\nComponents: %s", host, distribuition, (suites ?? ["main"]).join(" ")));
      return res.setHeader("Content-Type", "text/plain").send(data.join("\n"));
    } else if (type === "json") {
      return res.json({
        host,
        distribuitions: concatPackage.map(({distribuition, suitesName: suites}) => ({
          distribuition,
          suites: suites ?? ["main"],
        }))
      });
    }
    return res.setHeader("Content-Type", "text/plain").send(concatPackage.map(({distribuition, suitesName: suites}) => `deb ${host} ${Conflicting?"./":""}${distribuition} ${(suites ?? ["main"]).join(" ")}`).join("\n"));
  });

  // Download
  app.get("/pool/:dist/:suite/:packageName/:arch/:version/download.deb", async (req, res) => {
    const {dist, suite, packageName, arch, version} = req.params;
    return packInfos.getPackageStream(dist, suite, arch, packageName, version).then(({stream, control}) => stream.pipe(res.writeHead(200, {
      "Content-Type": "application/vnd.debian.binary-package",
      "Content-Length": control.Size,
      "Content-MD5": control.MD5sum,
      "Content-SHA1": control.SHA1,
      "Content-SHA256": control.SHA256,
    })));
  });
  app.get("/pool/:dist/:suite/:packageName/:arch/:version", (req, res) => res.json(packInfos.getPackageInfo(req.params.dist, req.params.suite, req.params.arch, req.params.packageName, req.params.version)));
  app.get("/pool/:dist/:suite/:packageName/:arch", (req, res) => res.json(packInfos.getPackageInfo(req.params.dist, req.params.suite, req.params.arch, req.params.packageName)));
  app.get("/pool/:dist/:suite/:packageName", (req, res) => res.json(packInfos.getPackageInfo(req.params.dist, req.params.suite, req.params.packageName)));
  app.get("/pool/:dist/:suite", (req, res) => res.json(packInfos.getPackageInfo(req.params.dist, req.params.suite)));
  app.get("/pool/:dist", (req, res) => res.json(packInfos.getPackageInfo(req.params.dist)));
  app.get(["/pool", "/"], (_req, res) => res.json(packInfos.getAllDistribuitions()));

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
    const { suitesName: suites, archs } = packInfos.getDistribuition(dist);
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
  // express().use(repositoryConfig["apt-config"]?.rootPath ?? "/", app).all("*", ({res}) => res.json({error: "404"})).listen(repositoryConfig["apt-config"].portListen, function () {return console.log(`apt-repo listening at http://localhost:${this.address().port}`);});
  app.listen(repositoryConfig["apt-config"].portListen, function () {return console.log(`apt-repo listening at http://localhost:${this.address().port}`);});

  // Loading and update packages
  const cronJobs: CronJob[] = [];
  const waitPromises: Promise<void>[] = [];
  for (const dist in repositoryConfig.repositories) {
    const targets = repositoryConfig.repositories[dist].targets;
    for (const repository of targets) {
      const update = async () => {
        if (repository.from === "oci") {
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
                    return new Promise<Readable>((done, reject) => registry.blobLayerStream(data.layer.digest).then(stream => {
                      stream.on("error", reject);
                      stream.pipe(tar.list({
                        onentry(getEntry) {
                          if (getEntry.path !== entry.path) return null;
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
            const release = await Promise.all(repository.tags.map(async releaseTag => httpRequestGithub.GithubRelease({
              owner: repository.owner,
              repository: repository.repository,
              token: repository.token,
              releaseTag,
            })));
            return Promise.all(release.map(async release => Promise.all(release.assets.map(async ({browser_download_url, name}) => {
              if (!name.endsWith(".deb")) return null;
              const getStream = () => httpRequest.pipeFetch(browser_download_url);
              const control = await DebianPackage.extractControl(await getStream());
              return packInfos.addPackage(dist, repository.suite ?? release.tag_name, {
                repositoryConfig: repository,
                control,
                getStream,
              });
            })))).then(data => data.flat(2).filter(Boolean));
          }
          const release = await httpRequestGithub.GithubRelease({owner: repository.owner, repository: repository.repository, token: repository.token, peer: repository.assetsLimit, all: false});
          return Promise.all(release.map(async release => Promise.all(release.assets.map(async ({browser_download_url, name}) => {
            if (!name.endsWith(".deb")) return null;
            const getStream = () => httpRequest.pipeFetch(browser_download_url);
            const control = await DebianPackage.extractControl(await getStream());
            return packInfos.addPackage(dist, repository.suite ?? release.tag_name, {
              repositoryConfig: repository,
              control,
              getStream,
            });
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
          return Promise.all(filtedTree.map(async ({path}) => {
            const getStream = () => httpRequest.pipeFetch(`https://raw.githubusercontent.com/${repository.owner}/${repository.repository}/${repository.tree}/${path}`);
            const control = await DebianPackage.extractControl(await getStream());
            return packInfos.addPackage(dist, repository.suite ?? repository.tree, {
              repositoryConfig: repository,
              control,
              getStream,
            });
          }));
        }
        console.log("%s not registred to manipulate package", repository.from);
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
  });
  // await Promise.all(waitPromises);
  return app;
}
