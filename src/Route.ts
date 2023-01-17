import cluster from "node:cluster";
import express from "express";
import configManeger, { aptSConfig } from "./configManeger.js";
import packageManeger, { packageStorage } from "./packageRegister.js";
import stream from "node:stream";
import path from "node:path";
import zlib from "node:zlib";
import lzma from "lzma-native";
import coreUtils from "@sirherobrine23/coreutils";
import { format } from "node:util";
import openpgp from "openpgp";

export class createAPTPackage extends stream.Readable {
  constructor(poolBase: string, packages: packageStorage[]){
    super({read(_size){}});
    let breakLine = false;
    for (const { packageControl } of packages) {
      const { Package, Version, Architecture } = packageControl;
      const Filename = path.posix.join(poolBase, Package, Version, Architecture, "download.deb");
      packageControl.Filename = Filename;
      if (breakLine) this.push("\n\n");
      this.push(Object.keys(packageControl).map((key) => `${key}: ${packageControl[key]}`).join("\n"));
    }
    this.push(null);
  }
}

async function createPackageHASH(...args: ConstructorParameters<typeof createAPTPackage>) {
  const packageStream = new createAPTPackage(...args);
  let rawSize = 0; packageStream.on("data", (chunk) => rawSize += chunk.length);
  const gzip = packageStream.pipe(zlib.createGzip());
  let gzipSize = 0; gzip.on("data", (chunk) => gzipSize += chunk.length);
  const xz = packageStream.pipe(lzma.Compressor());
  let xzSize = 0; xz.on("data", (chunk) => xzSize += chunk.length);

  const [rawHash, gzipHash, xzHash] = await Promise.all([coreUtils.extendsCrypto.createHashAsync("all", packageStream), coreUtils.extendsCrypto.createHashAsync("all", gzip), coreUtils.extendsCrypto.createHashAsync("all", xz)]);
  return {
    raw: {
      size: rawSize,
      hash: rawHash,
    },
    gzip: {
      size: gzipSize,
      hash: gzipHash,
    },
    xz: {
      size: xzSize,
      hash: xzHash,
    }
  };
}

export default createRouters;
export async function createRouters(config: string|aptSConfig) {
  const serverConfig = typeof config === "string" ? await configManeger(config) : config;
  const packagesManeger = await packageManeger(serverConfig);
  const app = express.Router();
  app.use(express.json()).use(express.urlencoded({ extended: true })).use((req, res, next) => {
    let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    if (Array.isArray(ip)) ip = ip[0];
    if (ip.slice(0, 7) === "::ffff:") ip = ip.slice(7);
    res.setHeader("Access-Control-Allow-Origin", "*").setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE").setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.json = (body) => {
      res.setHeader("Content-Type", "application/json");
      Promise.resolve(body).then((data) => res.send(JSON.stringify(data, (_, value) => {
        if (typeof value === "bigint") return value.toString();
        return value;
      }, 2)));
      return res;
    }

    const clusterID = cluster.worker?.id ?? 0;
    const baseMessage = "[Date: %s, Cluster: %s]: Method: %s, IP: %s, Path: %s";
    const reqDate = new Date();
    const { method, path: pathLocal } = req;
    console.log(baseMessage, reqDate.toUTCString(), clusterID, method, ip, pathLocal);
    res.once("close", () => {
      const endReqDate = new Date();
      return console.log(`${baseMessage}, Code: %f, res seconds: %f, `, endReqDate.toUTCString(), clusterID, method, ip, path, res.statusCode ?? null, endReqDate.getTime() - reqDate.getTime());
    });
    next();
  });

  async function createRelease(dist: string) {
    const distAptConfig = serverConfig.repositorys[dist]?.aptConfig;
    const Release: {[key: string]: string|string[]} = {};
    const packagesArray = await packagesManeger.getPackages(dist);
    // Date
    Release.Date = new Date().toUTCString();

    // Archs
    const Archs = [...(new Set(packagesArray.map(({ packageControl }) => packageControl.Architecture)))];
    if (!Archs.length) throw new Error("Check is dist have packages");
    Release.Architectures = Archs.join(" ");

    // Components
    const Components = [...(new Set(packagesArray.map(({ component }) => component)))];
    if (!Components.length) throw new Error("Check is dist have packages");
    Release.Components = Components.join(" ");

    // Origin
    const Origin = serverConfig.globalAptConfig?.Origin ?? distAptConfig?.Origin;
    if (Origin) Release.Origin = Origin;

    // Lebel
    const Label = distAptConfig?.Label ?? serverConfig.globalAptConfig?.Label;
    if (Label) Release.Label = Label;

    // Codename
    if (distAptConfig?.Codename) Release.Codename = distAptConfig?.Codename;

    // Version
    if (distAptConfig?.Version) Release.Version = distAptConfig.Version;

    // Description
    if (distAptConfig?.Description?.split("\n")?.[0]?.trim()) Release.Description = distAptConfig.Description.split("\n")[0].trim();

    if (serverConfig.server?.pgp || distAptConfig?.enableHashes) {
      Release.SHA256 = [];
      Release.SHA1 = [];
      Release.MD5sum = [];
      const HASHs = await Promise.all(Archs.map(async arch => Promise.all(Components.map(async comp => createPackageHASH(format("pool"), packagesArray.filter(x => ((["all", arch]).includes(x.packageControl.Architecture)) && x.component === comp)).then(data => ({arch, comp, data})))))).then(data => data.flat(3));
      for (const { arch, comp, data } of HASHs) {
        Release.SHA256.push(
          `${data.raw.hash.sha256} ${data.raw.size} ${format("%s/binary-%s/Packages", comp, arch)}`,
          `${data.gzip.hash.sha256} ${data.gzip.size} ${format("%s/binary-%s/Packages.gz", comp, arch)}`,
          `${data.xz.hash.sha256} ${data.xz.size} ${format("%s/binary-%s/Packages.xz", comp, arch)}`,
        );
        Release.SHA1.push(
          `${data.raw.hash.sha1} ${data.raw.size} ${format("%s/binary-%s/Packages", comp, arch)}`,
          `${data.gzip.hash.sha1} ${data.gzip.size} ${format("%s/binary-%s/Packages.gz", comp, arch)}`,
          `${data.xz.hash.sha1} ${data.xz.size} ${format("%s/binary-%s/Packages.xz", comp, arch)}`,
        );
        Release.MD5sum.push(
          `${data.raw.hash.md5} ${data.raw.size} ${format("%s/binary-%s/Packages", comp, arch)}`,
          `${data.gzip.hash.md5} ${data.gzip.size} ${format("%s/binary-%s/Packages.gz", comp, arch)}`,
          `${data.xz.hash.md5} ${data.xz.size} ${format("%s/binary-%s/Packages.xz", comp, arch)}`,
        );
      }
    }

    return Release;
  }

  function convertRelease(Release: any) {
    return Object.keys(Release).reduce((old, key) => {
      if (Array.isArray(Release[key])) old.push(`${key}:\n  ${(Release[key] as string[]).join("\n  ")}`);
      else old.push(`${key}: ${Release[key]}`);
      return old;
    }, []).join("\n");
  }

  const pgpKey = serverConfig.server?.pgp;
  app.get("/dists", ({}, res, next) => packagesManeger.getDists().then(data => res.json(data)).catch(next));
  app.get("/dists/:distName(/(In)?Release)?", ({params: {distName}, path}, res, next) => {
    return createRelease(distName).then(async Release => {
      if (path.endsWith("Release")) return res.setHeader("Content-Type", "text/plain").send(convertRelease(Release));
      else if (path.endsWith("InRelease")) {
        if (!pgpKey) return res.status(404).json({error: "PGP not found"});
        const privateKey = pgpKey.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: pgpKey.privateKey }), passphrase: pgpKey.passphrase}) : await openpgp.readPrivateKey({ armoredKey: pgpKey.privateKey });
        const ReleaseData = convertRelease(Release);
        return res.setHeader("Content-Type", "text/plain").send(await openpgp.sign({
          signingKeys: privateKey,
          format: "armored",
          message: await openpgp.createCleartextMessage({text: ReleaseData}),
        }));
      }
      return res.json(Release);
    }).catch(next);
  });

  app.get("/dists/:distName/Release.gpg", ({params: {distName}}, res, next) => {
    if (!pgpKey) return res.status(404).json({error: "PGP not found"});
    return createRelease(distName).then(async Release => {
      const privateKey = pgpKey.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: pgpKey.privateKey }), passphrase: pgpKey.passphrase}) : await openpgp.readPrivateKey({ armoredKey: pgpKey.privateKey });
      const ReleaseData = convertRelease(Release);
      return res.setHeader("Content-Type", "text/plain").send(await openpgp.sign({
        signingKeys: privateKey,
        format: "armored",
        message: await openpgp.createCleartextMessage({text: ReleaseData}),
      }));
    }).catch(next);
  });

  // Return router and config
  return {
    app,
    serverConfig,
  };
}