import { DebianPackage, httpRequestGithub, extendsCrypto, httpRequest, DockerRegistry } from "@sirherobrine23/coreutils";
import { Compressor as lzmaCompressor } from "lzma-native";
import { apt_config, getConfig, repository } from "./repoConfig.js";
import { Readable, Writable } from "node:stream";
import { createGzip } from "node:zlib";
import { CronJob } from "cron";
import { watchFile } from "node:fs";
import { format } from "node:util";
import express from "express";
import openpgp from "openpgp";
import tar from "tar";

type packageRegistry = {
  [dist: string]: {
    apt_config?: apt_config,
    targetsUpdate: (() => Promise<void>)[],
    targets: {
      [packageName: string]: {
        [arch: string]: {
          [version: string]: {
            config: repository,
            control: DebianPackage.debianControl,
            getStream: () => Readable|Promise<Readable>,
          }
        }
      }
    }
  }
};

export default async function main(configPath: string) {
  const packInfos: packageRegistry = {};
  let repositoryConfig = await getConfig(configPath);
  // watch config file changes
  watchFile(configPath, async () => {
    console.info("Config file changed, reloading config and update packages...");
    repositoryConfig = await getConfig(configPath);
    for (const dist in packInfos) await Promise.all(packInfos[dist].targetsUpdate.map((func) => func().catch(console.error)));
  });
  const app = express();
  app.disable("x-powered-by").disable("etag").use(express.json()).use(express.urlencoded({ extended: true })).use((req, res, next) => {
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
  app.get("/source_list", (req, res) => {
    let source = "";
    const host = repositoryConfig["apt-config"]?.sourcesHost ?? `${req.protocol}://${req.hostname}:${req.socket.localPort}`;
    for (const dist in packInfos) {
      for (const target in packInfos[dist]?.targets) {
        const suites = [...(new Set(Object.keys(packInfos[dist].targets[target]).flat().map((arch) => Object.keys(packInfos[dist].targets[target][arch]).map(version => packInfos[dist].targets[target][arch][version].config?.suite ?? "main")).flat()))];
        if (source) source += "\n";
        source += format("deb %s %s", host, dist, suites.join(" "));
      }
    }
    source += "\n";
    return res.setHeader("Content-Type", "text/plain").send(source);
  });

  app.get(["/", "/pool"], (_req, res) => {
    const packages = Object.keys(packInfos);
    const packagesVersions = packages.map((dist) => {
      const packages = Object.keys(packInfos[dist].targets).map(packageName => {
        const arch = Object.keys(packInfos[dist].targets[packageName]);
        const packageCount = arch.map(arch => Object.keys(packInfos[dist].targets[packageName][arch]).length).reduce((a, b) => a + b);
        return {
          package: packageName,
          packageCount,
          arch,
        };
      });
      const arch = [...(new Set(packages.map(({arch}) => arch).flat()))];
      return {
        dist,
        packages,
        arch,
      };
    });
    return res.json(packagesVersions);
  });

  // Download
  app.get("/pool/:dist/:packageName/:arch/:version/download.deb", async (req, res) => {
    const dist = packInfos[req.params.dist];
    if (!dist) return res.status(400).json({error: "Dist not found"});
    const packageobject = dist.targets[req.params.packageName];
    if (!packageobject) return res.status(400).json({error: "Package not found"});
    const arch = packageobject[req.params.arch];
    if (!arch) return res.status(400).json({error: "Arch not found"});
    const version = arch[req.params.version];
    if (!version) return res.status(400).json({error: "Version not found"});
    return Promise.resolve().then(() => version.getStream()).then(stream => stream.pipe(res.writeHead(200, {
      "Content-Type": "application/vnd.debian.binary-package",
      "Content-Length": version.control.Size,
      "Content-MD5": version.control.MD5sum,
      "Content-SHA1": version.control.SHA1,
      "Content-SHA256": version.control.SHA256,
    })));
  });
  app.get("/pool/:dist/:packageName/:arch/:version", async (req, res) => {
    const dist = packInfos[req.params.dist];
    if (!dist) return res.status(400).json({error: "Dist not found"});
    const packageobject = dist.targets[req.params.packageName];
    if (!packageobject) return res.status(400).json({error: "Package not found"});
    const arch = packageobject[req.params.arch];
    if (!arch) return res.status(400).json({error: "Arch not found"});
    const version = arch[req.params.version];
    if (!version) return res.status(400).json({error: "Version not found"});
    return res.json(version.control);
  });
  app.get("/pool/:dist/:packageName/:arch", async (req, res) => {
    const dist = packInfos[req.params.dist];
    if (!dist) return res.status(400).json({error: "Dist not found"});
    const packageobject = dist.targets[req.params.packageName];
    if (!packageobject) return res.status(400).json({error: "Package not found"});
    const arch = packageobject[req.params.arch];
    if (!arch) return res.status(400).json({error: "Arch not found"});
    return res.json(Object.keys(arch));
  });
  app.get("/pool/:dist/:packageName", async (req, res) => {
    const dist = packInfos[req.params.dist];
    if (!dist) return res.status(400).json({error: "Dist not found"});
    const packageobject = dist.targets[req.params.packageName];
    if (!packageobject) return res.status(400).json({error: "Package not found"});
    return res.json(Object.keys(packageobject));
  });
  app.get("/pool/:dist", async (req, res) => {
    const dist = packInfos[req.params.dist];
    if (!dist) return res.status(400).json({error: "Dist not found"});
    return res.json(Object.keys(dist.targets));
  });

  async function createPackages(options?: {compress?: "gzip" | "xz", writeStream?: Writable, dist?: string, package?: string, arch?: string, suite?: string}) {
    const rawWrite = new Readable({read(){}});
    let size = 0;
    let hash: ReturnType<typeof extendsCrypto.createHashAsync>|undefined;
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

    let addbreak = false;
    for (const dist in packInfos) {
      if (options?.dist && dist !== options.dist) continue;
      for (const packageName in packInfos[dist]?.targets ?? {}) {
        if (options?.package && packageName !== options.package) continue;
        const packageobject = packInfos[dist]?.targets?.[packageName] ?? {};
        for (const arch in packageobject) {
          if (options?.arch && arch !== options.arch) continue;
          for (const version in packageobject[arch]) {
            if (addbreak) rawWrite.push("\n\n");
            addbreak = true;
            const {control} = packageobject[arch][version];
            const Data = [
              `Package: ${packageName}`,
              `Version: ${version}`,
              `Architecture: ${arch}`,
              `Maintainer: ${control.Maintainer}`,
              `Depends: ${control.Depends}`,
              `Size: ${control.Size}`,
              `MD5sum: ${control.MD5sum}`,
              `SHA1: ${control.SHA1}`,
              `SHA256: ${control.SHA256}`,
            ];

            Data.push(`Filename: pool/${dist}/${packageName}/${arch}/${version}/download.deb`);
            if (control.Homepage) Data.push(`Homepage: ${control.Homepage}`);
            if (control.Description) Data.push(`Description: ${control.Description}`);

            // Register
            rawWrite.push(Data.join("\n"));
          }
        }
      }
    }

    rawWrite.push(null);
    if (hash) return hash.then(hash => ({...hash, size}));
    return null;
  }

  app.get("/dists/:dist/:suite/binary-:arch/Packages(.(xz|gz)|)", (req, res) => {
    if (req.path.endsWith(".gz")) {
      createPackages({
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
      createPackages({
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
      createPackages({
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
    const packageobject = packInfos[dist];
    if (!packageobject) throw new Error("Dist not found");
    const ReleaseLines = [];

    // Origin
    const Origin = packageobject.apt_config?.origin || repositoryConfig["apt-config"]?.origin || "apt-stream";
    ReleaseLines.push(`Origin: ${Origin}`);

    // Lebel
    const Label = packageobject.apt_config?.label || repositoryConfig["apt-config"]?.label || "apt-stream";
    ReleaseLines.push(`Label: ${Label}`);

    // Codename if exists
    const codename = packageobject.apt_config?.codename || repositoryConfig["apt-config"]?.codename;
    if (codename) ReleaseLines.push(`Codename: ${codename}`);

    // Date
    ReleaseLines.push(`Date: ${new Date().toUTCString()}`);

    // Suite
    const Suites = [...(new Set(Object.keys(packageobject.targets).map(pack => Object.keys(packageobject.targets[pack]).map(arch => Object.keys(packageobject.targets[pack][arch]).map(version => packageobject.targets[pack][arch][version]?.config?.suite))).flat(3)))];
    if (Suites.length === 0) Suites.push("main");

    // Architectures
    const archs = [...(new Set(Object.keys(packageobject.targets).map(pack => Object.keys(packageobject.targets[pack])).flat()))];
    if (archs.length === 0) throw new Error("No architectures found");
    ReleaseLines.push(`Architectures: ${archs.join(" ")}`);

    const createPackagesHash = packageobject.apt_config?.enableHash ?? repositoryConfig["apt-config"]?.enableHash ?? true;
    if (createPackagesHash) {
      const sha256: {file: string, size: number, hash: string}[] = [];
      const sha1: {file: string, size: number, hash: string}[] = [];
      const md5: {file: string, size: number, hash: string}[] = [];

      for (const arch of archs) {
        for (const suite of Suites) {
          const gzip = await createPackages({compress: "gzip", dist, arch, suite});
          if (gzip) {
            sha256.push({file: `${suite}/binary-${arch}/Packages.gz`, size: gzip.size, hash: gzip.sha256});
            sha1.push({file: `${suite}/binary-${arch}/Packages.gz`, size: gzip.size, hash: gzip.sha1});
            md5.push({file: `${suite}/binary-${arch}/Packages.gz`, size: gzip.size, hash: gzip.md5});
          }
          const xz = await createPackages({compress: "xz", dist, arch, suite});
          if (xz) {
            sha256.push({file: `${suite}/binary-${arch}/Packages.xz`, size: xz.size, hash: xz.sha256});
            sha1.push({file: `${suite}/binary-${arch}/Packages.xz`, size: xz.size, hash: xz.sha1});
            md5.push({file: `${suite}/binary-${arch}/Packages.xz`, size: xz.size, hash: xz.md5});
          }
          const raw = await createPackages({dist, arch, suite});
          if (raw) {
            sha256.push({file: `${suite}/binary-${arch}/Packages`, size: raw.size, hash: raw.sha256});
            sha1.push({file: `${suite}/binary-${arch}/Packages`, size: raw.size, hash: raw.sha1});
            md5.push({file: `${suite}/binary-${arch}/Packages`, size: raw.size, hash: raw.md5});
          }
        }
      }

      if (sha256.length > 0) ReleaseLines.push(`SHA256:${sha256.sort().map((hash) => `\n  ${hash.hash} ${hash.size} ${hash.file}`).join("")}`);
      if (sha1.length > 0) ReleaseLines.push(`SHA1:${sha1.sort().map((hash) => `\n  ${hash.hash} ${hash.size} ${hash.file}`).join("")}`);
      if (md5.length > 0) ReleaseLines.push(`MD5Sum:${md5.sort().map((hash) => `\n  ${hash.hash} ${hash.size} ${hash.file}`).join("")}`);
    }

    return ReleaseLines.join("\n");
  }
  app.get("/dists/:dist/Release", (req, res, next) => createReleaseV1(req.params.dist).then((data) => res.setHeader("Content-Type", "text/plain").send(data)).catch(next));
  app.get("/dists/:dist/InRelease", (req, res, next) => {
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
  app.get("/dists/:dist/Release.gpg", (req, res, next) => {
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
      stack: err?.stack,
    });
  });

  // Listen HTTP server
  app.listen(repositoryConfig["apt-config"].portListen, function () {return console.log(`apt-repo listening at http://localhost:${this.address().port}`);});

  // Loading and update packages
  const cronJobs: CronJob[] = [];
  for (const dist in repositoryConfig.repositories) {
    const targets = repositoryConfig.repositories[dist].targets;
    const apt_config = repositoryConfig.repositories[dist]["apt-config"];
    if (!packInfos[dist]) packInfos[dist] = {
      apt_config,
      targets: {},
      targetsUpdate: [],
    };
    for (const repository of targets) {
      const update = async () => {
        if (repository.from === "github_release") {
          if (repository.takeUpTo) if (repository.takeUpTo > 100) throw new Error("takeUpTo must be less than 100, because of github api limit");
          const relData = repository.tags ? await Promise.all(repository.tags.map(async (tag) => httpRequestGithub.GithubRelease({repository: repository.repository, owner: repository.owner, token: repository.token, releaseTag: tag}))) : (await httpRequestGithub.GithubRelease({repository: repository.repository, owner: repository.owner, token: repository.token, peer: repository.takeUpTo, all: false})).slice(0, 50);
          const assets = relData.flat().map((rel) => rel.assets).flat().filter((asset) => asset.name.endsWith(".deb")).flat();
          const newAssests = new Array(Math.ceil(assets.length / 6)).fill(0).map(() => assets.splice(0, 6));
          for (const assets of newAssests) await Promise.all(assets.map(async (asset) => {
            console.info(`[INFO] Get control ${dist} ${asset.name} ${asset.browser_download_url}`)
            const getStream = () => httpRequest.pipeFetch(asset.browser_download_url);
            const control = await DebianPackage.extractControl(await getStream());
            if (!packInfos[dist].targets[control.Package]) packInfos[dist].targets[control.Package] = {};
            if (!packInfos[dist].targets[control.Package][control.Architecture]) packInfos[dist].targets[control.Package][control.Architecture] = {};
            console.info(`[INFO] Add/Replace ${dist} ${control.Package} ${control.Version} ${control.Architecture} ${asset.browser_download_url}`);
            return packInfos[dist].targets[control.Package][control.Architecture][control.Version] = {
              config: repository,
              control,
              getStream: getStream,
            };
          }));
        } else if (repository.from === "oci") {
          const registry = await DockerRegistry.Manifest.Manifest(repository.image, repository.platfom_target);
          await registry.layersStream((data) => {
            if (!(["gzip", "gz", "tar"]).some(ends => data.layer.mediaType.endsWith(ends))) return data.next();
            data.stream.pipe(tar.list({
              async onentry(entry) {
                if (!entry.path.endsWith(".deb")) return null;
                console.info(`[INFO] Get control ${dist} ${entry.path} ${repository.image} ${entry.path}`);
                const control = await DebianPackage.extractControl(entry as any);
                if (!packInfos[dist].targets[control.Package]) packInfos[dist].targets[control.Package] = {};
                if (!packInfos[dist].targets[control.Package][control.Architecture]) packInfos[dist].targets[control.Package][control.Architecture] = {};
                console.info(`[INFO] Add/Replace ${dist} ${control.Package} ${control.Version} ${control.Architecture} ${repository.image} ${entry.path}`);
                packInfos[dist].targets[control.Package][control.Architecture][control.Version] = {
                  config: repository,
                  control,
                  getStream: async () => {
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
                };
              }
            }));
          });
        }
      }
      await update().then(() => {
        const cron = (repository.cronRefresh ?? []).map((cron) => new CronJob(cron, update));
        cron.forEach((cron) => cron.start());
        cronJobs.push(...cron);
        packInfos[dist].targetsUpdate.push(update);
      }).catch(console.error);
    }
  }
}