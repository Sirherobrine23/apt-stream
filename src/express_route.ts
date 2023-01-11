import { Compressor as lzmaCompress } from "lzma-native";
import { createGzip } from "node:zlib";
import { getConfig } from "./repoConfig.js";
import { Readable } from "node:stream";
import package_maneger, { packageSave } from "./packagesData.js";
import coreUtils from "@sirherobrine23/coreutils";
import cluster from "node:cluster";
import express from "express";
import openpgp from "openpgp";
import semver from "semver";
import path from "node:path";
import os from "node:os";

export default async function initApp(config: string) {
  const packageConfig = await getConfig(config);
  const packageManeger = await package_maneger(packageConfig);
  const app = express();
  app.disable("x-powered-by").disable("etag").use(express.json()).use(express.urlencoded({extended: true})).use((req, res, next) => {
    res.json = data => {
      Promise.resolve(data).then(data => res.setHeader("Content-Type", "application/json").send(JSON.stringify(data, null, 2))).catch(next);
      return res;
    };
    const cluserID = (cluster.worker?.id === 1 ? "Primary" : cluster.worker?.id) ?? "Primary";
    console.log("[%s, cluserID: %s]: Path: %s, Method: %s, IP: %s", new Date().toISOString(), cluserID, req.path, req.method, req.ip);
    res.on("close", () => console.log("[%s, cluserID: %s]: Path: %s, Method: %s, IP: %s, Status: %f", new Date().toISOString(), cluserID, req.path, req.method, req.ip, res.statusCode));
    next();
  });

  // Info
  const createTime = Date.now();
  app.get("/", ({res}) => {
    return res.json({
      cluster: cluster.worker?.id ?? "No clustered",
      cpuCores: os.cpus().length || "Unknown CPU core",
      hostArch: process.arch,
      hostPlatform: process.platform,
      nodeVersion: process.version,
      uptime: Date.now() - createTime,
      isUptime: parseInt(`${os.uptime() * 1000}`),
    });
  });

  app.get("/pool/:dist/:suite/:package/:arch/:version/download.deb", async ({params: {dist, suite, package: packageName, arch, version}}, res, next) => {
    try {
      const data = (await packageManeger.getPackages(dist, suite, packageName, arch, version))?.at(-1);
      if (!data) return next(new Error("Not Found"));
      const fileStream = await data.getFileStream();
      fileStream.pipe(res.writeHead(200, {
        "Content-Type": "application/x-debian-package",
        "Content-Length": data.control.Size,
        "Content-Disposition": `attachment; filename="${packageName}_${version}_${arch}.deb"`,
        "SHA256_hash": data.control.SHA256,
        "MD5Sum_hash": data.control.MD5sum
      }));
    } catch (err) {
      next(err);
    }
  });
  app.get("/pool/:dist/:suite/:package/:arch/:version", (req, res, next) => packageManeger.getPackages(req.params.dist, req.params.suite, req.params.package, req.params.arch, req.params.version).then(data => res.json(data.at(-1).control)).catch(next));
  app.get("/pool/:dist/:suite/:package/:arch", (req, res, next) => packageManeger.getPackages(req.params.dist, req.params.suite, req.params.package, req.params.arch).then(data => res.json(data.map(({control}) => control))).catch(next));
  app.get("/pool/:dist/:suite/:package", (req, res, next) => packageManeger.getPackages(req.params.dist, req.params.suite, req.params.package).then(data => res.json(data.map(({control}) => control))).catch(next));
  app.get("/pool/:dist/:suite", (req, res, next) => packageManeger.getPackages(req.params.dist, req.params.suite).then(data => res.json(data.map(x => x.control))).catch(next));
  app.get("/pool/:dist", (req, res, next) => packageManeger.getPackages(req.params.dist).then(data => res.json(data.reduce((old, current) => {
    if (!old[current.suite]) old[current.suite] = [];
    old[current.suite].push(current.control);
    return old;
  }, {}))).catch(next));

  app.get("/pool", ({}, res, next) => packageManeger.getPackages().then(data => res.json(data.reduce((old, current) => {
    if (!old[current.dist]) old[current.dist] = {};
    if (!old[current.dist][current.suite]) old[current.dist][current.suite] = [];
    old[current.dist][current.suite].push(current.control);
    return old;
  }, {}))).catch(next));

  // Package list
  app.get("/source(s)?(.list)?", async (req, res, next) => {
    try {
      const dists = await Promise.all(await packageManeger.getDists().then(data => data.map(dist => packageManeger.getDistInfo(dist).then(data => ({dist, data})))));
      res.set("Content-Type", "text/plain");
      const remotePath = path.posix.resolve(req.baseUrl + req.path, ".."), protocol = req.headers["x-forwarded-proto"] ?? req.protocol, hostname = process.env["RAILWAY_STATIC_URL"] ?? `${req.hostname}:${req.socket.localPort}`, host = packageConfig["apt-config"]?.sourcesHost ?? `${protocol}://${hostname}${remotePath}`;
      const data = [];
      for (const {dist, data: {suites}} of dists) data.push(`deb ${host} ${dist} ${suites.join(" ")}`);
      return res.send(data.join("\n"));
    } catch (err) {return next(err);}
  });

  // Dists info
  app.get("/dists", ({}, res, next) => packageManeger.getDists().then(data => res.json(data)).catch(next));
  app.get("/dists/:dist", ({params: {dist}}, res, next) => packageManeger.getDistInfo(dist).then(data => res.json(data)).catch(next));
  app.get("/dists/:dist/source(s)?(.list)?", async (req, res, next) => {
    const {dist} = req.params;
    try {
      const data = await packageManeger.getDistInfo(dist);
      res.set("Content-Type", "text/plain");
      const remotePath = path.posix.resolve(req.baseUrl + req.path, ".."), protocol = req.headers["x-forwarded-proto"] ?? req.protocol, hostname = process.env["RAILWAY_STATIC_URL"] ?? `${req.hostname}:${req.socket.localPort}`, host = packageConfig["apt-config"]?.sourcesHost ?? `${protocol}://${hostname}${remotePath}`;
      return res.send(`deb ${host} ${dist} ${data.suites.join(" ")}`);
    } catch (err) {return next(err);}
  });

  // Create Package, Package.gz and Package.xz
  function createPackages(packages: packageSave[], dist: string, suite: string) {
    if (!packages.length) throw new Error("Check is dist or suite have packages");
    const reduced = packages.reduce((old, current) => {
      if (!old[current.control.Package]) old[current.control.Package] = [];
      old[current.control.Package].push(current);
      return old;
    }, {} as {[packageName: string]: packageSave[]});
    packages = [];
    Object.keys(reduced).forEach(packageName => {
      reduced[packageName] = reduced[packageName].sort((b, a) => {
        const aVersion = semver.valid(semver.coerce(a.control.Version) ?? ""), bVersion = semver.valid(semver.coerce(b.control.Version) ?? "");
        return semver.compare(aVersion, bVersion);
      });
      if (!packageConfig["apt-config"]?.packagesOptions?.uniqueVersion) packages.push(...reduced[packageName]);
      else {
        const at = reduced[packageName].at(0);
        if (at) packages.push(at);
      }
    });

    let rawSize = 0, gzipSize = 0, lzmaSize = 0;
    const mainReadstream = new Readable({read(){}}), rawSUMs = coreUtils.extendsCrypto.createHashAsync("all", mainReadstream).then(hash => ({size: rawSize, hash}));
    const gzip = mainReadstream.pipe(createGzip()), gzipSUMs = coreUtils.extendsCrypto.createHashAsync("all", gzip).then(hash => ({size: gzipSize, hash}));
    const lzma = mainReadstream.pipe(lzmaCompress()), lzmaSUMs = coreUtils.extendsCrypto.createHashAsync("all", lzma).then(hash => ({size: lzmaSize, hash}));
    mainReadstream.on("data", data => rawSize += data.length);
    gzip.on("data", data => gzipSize += data.length);
    lzma.on("data", data => lzmaSize += data.length);
    let fist = true;
    for (const {control} of packages) {
      if (!(control.Size && (control.MD5sum || control.SHA256 || control.SHA1))) continue;
      if (fist) fist = false; else mainReadstream.push("\n\n");
      control.Filename = `pool/${dist}/${suite}/${control.Package}/${control.Architecture}/${control.Version}/download.deb`;
      mainReadstream.push(Object.keys(control).map(key => `${key}: ${control[key]}`).join("\n"));
    }
    mainReadstream.push(null);

    return {
      raw: mainReadstream,
      gzip,
      lzma,
      SUMs: {
        raw: rawSUMs,
        gzip: gzipSUMs,
        lzma: lzmaSUMs
      }
    };
  }

  app.get("/dists/(./)?:dist/:suite/binary-:arch/Packages(.(xz|gz)|)", async ({params: {dist, suite, arch}, path: reqPath}, res, next) => {
    try {
      const packages = createPackages(await packageManeger.getPackages(dist, suite, undefined, arch), dist, suite);
      if (reqPath.endsWith(".gz")) return packages.gzip.pipe(res);
      else if (reqPath.endsWith(".xz")) return packages.lzma.pipe(res);
      else return packages.raw.pipe(res);
    } catch (err) {return next(err);}
  });
  // Release
  async function createRelease(dist: string) {
    if (!await packageManeger.existsDist(dist)) throw new Error("Dist exists");
    const packagesArray = await packageManeger.getPackages(dist);
    const Release: {[key: string]: string|string[]} = {};

    // Date
    Release.Date = new Date().toUTCString();

    // Origin
    const Origin = packageConfig["apt-config"]?.origin ?? packagesArray.find(x => x.aptConfig?.origin)?.aptConfig?.origin;
    if (Origin) Release.Origin = Origin;

    // Lebel
    const Label = packageConfig["apt-config"]?.label ?? packagesArray.find(x => x.aptConfig?.label)?.aptConfig?.label;
    if (Label) Release.Label = Label;

    // Codename
    const Codename = packageConfig["apt-config"]?.codename ?? packagesArray.find(x => x.aptConfig?.codename)?.aptConfig?.codename;
    if (Codename) Release.Codename = Codename;

    // Archs
    const Archs = ([...(new Set(packagesArray.map(x => x.control.Architecture)))]);
    if (!Archs.length) throw new Error("Check is dist have packages");
    Release.Architectures = Archs.join(" ");

    // Components
    const Components = ([...(new Set(packagesArray.map(x => x.suite)))]);
    if (!Components.length) throw new Error("Check is dist have packages");
    Release.Components = Components.join(" ");

    // Description

    // Sum's
    const enableHash = Boolean(packageConfig["apt-config"]?.enableHash ?? packagesArray.find(x => x.aptConfig?.enableHash)?.aptConfig?.enableHash);
    if (enableHash) {
      Release.SHA256 = [];
      Release.SHA1 = [];
      Release.MD5sum = [];
      const files = await Promise.all(Archs.map(async Arch => Promise.all(Components.map(async Component => {
        const archPackages = packagesArray.filter(x => x.control.Architecture === Arch && x.suite === Component);
        const {SUMs} = createPackages(archPackages, dist, Component);
        return [
          {
            file: `${Component}/binary-${Arch}/Packages`,
            hash: await SUMs.raw
          },
          {
            file: `${Component}/binary-${Arch}/Packages.gz`,
            hash: await SUMs.gzip
          },
          {
            file: `${Component}/binary-${Arch}/Packages.xz`,
            hash: await SUMs.lzma
          }
        ]
      })))).then(f => f.flat(3));

      files.forEach(({file, hash}) => {
        if (hash.hash.sha256) (Release.SHA256 as string[]).push(`${hash.hash.sha256} ${hash.size} ${file}`);
        if (hash.hash.sha1) (Release.SHA1 as string[]).push(`${hash.hash.sha1} ${hash.size} ${file}`);
        if (hash.hash.md5) (Release.MD5sum as string[]).push(`${hash.hash.md5} ${hash.size} ${file}`);
      });
    }

    return Object.keys(Release).reduce((old, key) => {
      if (Array.isArray(Release[key])) old.push(`${key}:\n  ${(Release[key] as string[]).join("\n  ")}`);
      else old.push(`${key}: ${Release[key]}`);
      return old;
    }, []).join("\n");
  }
  app.get("/dists/(./)?:dist/Release", ({params: {dist}}, res, next) => createRelease(dist).then(release => res.setHeader("Content-Type", "text/plain").send(release)).catch(next));

  const pgpKey = packageConfig["apt-config"]?.pgpKey;
  app.get("/dists/(./)?:dist/inRelease", async (req, res, next) => {
    if (!pgpKey) return res.status(404).json({error: "No PGP key found"});
    return Promise.resolve().then(async () => {
      const privateKey = pgpKey.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: pgpKey.private }), passphrase: pgpKey.passphrase}) : await openpgp.readPrivateKey({ armoredKey: pgpKey.private });
      const Release = await createRelease(req.params.dist);
      return res.setHeader("Content-Type", "text/plain").send(await openpgp.sign({
        signingKeys: privateKey,
        format: "armored",
        message: await openpgp.createCleartextMessage({text: Release}),
      }));
    }).catch(next);
  });
  app.get("/dists/(./)?:dist/Release.gpg", async (req, res, next) => {
    if (!pgpKey) return res.status(404).json({error: "No PGP key found"});
    return Promise.resolve().then(async () => {
      const privateKey = pgpKey.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: pgpKey.private }), passphrase: pgpKey.passphrase}) : await openpgp.readPrivateKey({ armoredKey: pgpKey.private });
      const Release = await createRelease(req.params.dist);
      return res.setHeader("Content-Type", "text/plain").send(await openpgp.sign({
        signingKeys: privateKey,
        message: await openpgp.createMessage({text: Release}),
      }));
    }).catch(next);
  });
  // Public key
  if (pgpKey) app.get(["/public_key", "/public.gpg"], async ({res}) => {
    if (!pgpKey) return res.status(400).json({error: "This repository no sign Packages files"});
    const pubKey = (await openpgp.readKey({ armoredKey: pgpKey.public })).armor();
    return res.setHeader("Content-Type", "application/pgp-keys").send(pubKey);
  });

  return {
    app,
    packageManeger,
    packageConfig
  };
}