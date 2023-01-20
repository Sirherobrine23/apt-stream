import packageManeger, { packageStorage } from "./packageRegister.js";
import configManeger, { aptSConfig } from "./configManeger.js";
import { format } from "node:util";
import coreUtils from "@sirherobrine23/coreutils";
import express from "express";
import openpgp from "openpgp";
import stream from "node:stream";
import path from "node:path";
import zlib from "node:zlib";
import lzma from "lzma-native";

export class createAPTPackage extends stream.Readable {
  constructor(poolBase: string, packages: packageStorage[]){
    super({read(_size){}});
    if (!packages.length) throw new Error("Check is dist have packages");
    let breakLine = false;
    for (const { packageControl, component } of packages) {
      const { Package, Version, Architecture } = packageControl;
      const Filename = path.posix.join(
        poolBase.replace(/^\//, ""),
        "pool",
        component,
        Package,
        Version,
        Architecture,
        "download.deb"
      );
      packageControl.Filename = Filename;
      if (breakLine) this.push("\n\n");
      this.push(coreUtils.DebianPackage.createControl(packageControl));
      breakLine = true;
    }
    this.push(null);
  }
}

async function createPackageHASH(...args: ConstructorParameters<typeof createAPTPackage>) {
  const packageStream = new createAPTPackage(...args);
  let rawSize = 0; packageStream.on("data", (chunk) => rawSize += chunk.length);
  const rawHash = coreUtils.extendsCrypto.createHashAsync(packageStream);
  const gzip = packageStream.pipe(zlib.createGzip());
  let gzipSize = 0; gzip.on("data", (chunk) => gzipSize += chunk.length);
  const gzipHash = coreUtils.extendsCrypto.createHashAsync(gzip);
  const xz = packageStream.pipe(lzma.Compressor());
  let xzSize = 0; xz.on("data", (chunk) => xzSize += chunk.length);
  const xzHash = coreUtils.extendsCrypto.createHashAsync(xz);

  const [rawHashB, gzipHashB, xzHashB] = await Promise.all([rawHash, gzipHash, xzHash]);
  return {
    raw: {
      hash: rawHashB,
      size: rawSize,
    },
    gzip: {
      hash: gzipHashB,
      size: gzipSize,
    },
    xz: {
      hash: xzHashB,
      size: xzSize,
    }
  };
}

export default createRouters;
export async function createRouters(config: string|aptSConfig) {
  const serverConfig = typeof config === "string" ? await configManeger(config) : config;
  const packagesManeger = await packageManeger(serverConfig);
  const pgpKey = serverConfig.server?.pgp;
  const app = express.Router();
  app.use(express.json()).use(express.urlencoded({ extended: true }));
  async function createRelease(aptRoot: string, dist: string) {
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
      const HASHs = await Promise.all(Archs.map(async arch => Promise.all(Components.map(async comp => createPackageHASH(aptRoot, packagesArray.filter(x => ((["all", arch]).includes(x.packageControl.Architecture)) && x.component === comp)).then(data => ({arch, comp, data})).catch(() => ({arch, comp, data: null})))))).then(data => data.flat(3));
      for (const HASH of HASHs) {
        if (!HASH.data) continue;
        const { arch, comp, data } = HASH;
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

  // Source.list
  app.get("/source(s)?(((.|_)list)?)", async (req, res) => {
    const remotePath = path.posix.resolve(req.baseUrl + req.path, ".."), protocol = req.headers["x-forwarded-proto"] ?? req.protocol, hostname = process.env["RAILWAY_STATIC_URL"] ?? `${req.hostname}:${req.socket.localPort}`, host = `${protocol}://${hostname}${remotePath}`;
    const data = await Promise.all((await packagesManeger.getDists()).map(async dist => packagesManeger.getDistInfo(dist).then(data => ({...data, dist}))));
    if (!data.length) return res.status(400).json({ error: "Apt-stream not configured" });
    return res.status(200).setHeader("Content-Type", "text/plain").send(data.map(data => `deb ${host} ${data.dist} ${data.components.join(" ")}`).join("\n"));
  });

  // Public key
  app.get("/public(Key|key|_key|_Key)?(.(key|gpg))?", async (_req, res) => {
    if (!pgpKey) return res.status(404).json({ error: "Repository not signed" });
    return res.status(200).setHeader("Content-Type", "application/pgp-keys").send(pgpKey.publicKey);
  });

  // pool/v2.21.1/gh/2.21.1/arm64/download.deb
  app.get("/pool(/:packageComponent)?(/:packageName)?(/:packageVersion)?(/:packageArch)?(/download.deb)?", ({originalUrl: reqPath, params}, res, next) => {
    let { packageComponent, packageName, packageVersion, packageArch } = params;
    return Promise.resolve().then(async () => {
      if (reqPath.endsWith("download.deb")) {
        return packagesManeger.getFileStream({
          component: packageComponent,
          version: packageVersion,
          arch: packageArch,
          packageName
        }).then(stream => stream.pipe(res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${packageName}_${packageVersion}_${packageArch}.deb"`,
        })));
      } else if (packageComponent && packageArch && packageVersion && packageName) {
        let packages = await packagesManeger.getPackages(undefined, packageComponent);
        packages = packages.filter(x => x.packageControl.Architecture === packageArch && x.packageControl.Version === packageVersion && x.packageControl.Package === packageName);
        if (!packages.length) throw new Error("Package not found");
        return res.json(packages.at(-1)?.packageControl);
      } else if (packageComponent && packageArch && packageVersion) {
        const packages = await packagesManeger.getPackages(undefined, packageComponent);
        return res.json(packages.filter(x => x.packageControl.Architecture === packageArch && x.packageControl.Version === packageVersion).reduce((main, b) => {
          if (!main[b.packageControl.Package]) main[b.packageControl.Package] = [];
          main[b.packageControl.Package].push(b.packageControl);
          return main;
        }, {}));
      } else if (packageComponent && packageArch) {
        const packages = await packagesManeger.getPackages(undefined, packageComponent);
        return res.json(packages.filter(x => x.packageControl.Architecture === packageArch).reduce((main, b) => {
          if (!main[b.packageControl.Package]) main[b.packageControl.Package] = [];
          main[b.packageControl.Package].push(b.packageControl);
          return main;
        }, {}));
      } else if (packageComponent) {
        const packages = await packagesManeger.getPackages(undefined, packageComponent);
        return res.json(packages.reduce((main, b) => {
          if (!main[b.packageControl.Package]) main[b.packageControl.Package] = [];
          main[b.packageControl.Package].push(b.packageControl);
          return main;
        }, {}));
      } else {
        const packages = await packagesManeger.getPackages();
        return res.json(packages.reduce((main, b) => {
          if (!main[b.component]) main[b.component] = {};
          if (!main[b.component][b.packageControl.Package]) main[b.component][b.packageControl.Package] = [];
          main[b.component][b.packageControl.Package].push(b.packageControl);
          return main;
        }, {}));
      }
    }).catch(next);
  });

  app.get("/dists", ({}, res, next) => packagesManeger.getDists().then(data => res.json(data)).catch(next));
  app.get("/dists/:distName", ({params: {distName}, originalUrl: reqPath}, res, next) => createRelease(path.posix.resolve("/", reqPath, ".."), distName).then(Release => res.json(Release)).catch(next));
  app.get("/dists/:distName/((In)?Release)", ({params: {distName}, originalUrl: reqPath}, res, next) => {
    const aptRoot = path.posix.resolve("/", reqPath, "..");
    return createRelease(aptRoot, distName).then(async Release => {
      if (reqPath.endsWith("InRelease")) {
        if (!pgpKey) return res.status(404).json({error: "PGP not found"});
        const privateKey = pgpKey.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: pgpKey.privateKey }), passphrase: pgpKey.passphrase}) : await openpgp.readPrivateKey({ armoredKey: pgpKey.privateKey });
        const ReleaseData = convertRelease(Release);
        return res.setHeader("Content-Type", "text/plain").send(await openpgp.sign({
          signingKeys: privateKey,
          format: "armored",
          message: await openpgp.createCleartextMessage({text: ReleaseData}),
        }));
      }
      return res.setHeader("Content-Type", "text/plain").send(convertRelease(Release));
    }).catch(next);
  });

  app.get("/dists/:distName/Release.gpg", ({params: {distName}, originalUrl: reqPath}, res, next) => {
    const aptRoot = path.posix.resolve("/", reqPath, "../..");
    if (!pgpKey) return res.status(404).json({error: "PGP not found"});
    return createRelease(aptRoot, distName).then(async Release => {
      const privateKey = pgpKey.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: pgpKey.privateKey }), passphrase: pgpKey.passphrase}) : await openpgp.readPrivateKey({ armoredKey: pgpKey.privateKey });
      const ReleaseData = convertRelease(Release);
      return res.setHeader("Content-Type", "text/plain").send(await openpgp.sign({
        signingKeys: privateKey,
        format: "armored",
        message: await openpgp.createCleartextMessage({text: ReleaseData}),
      }));
    }).catch(next);
  });

  app.get("/dists/:distName/:component/binary-:arch/Packages(.(xz|gz))?", ({params: {distName, component, arch}, originalUrl: reqPath}, res, next) => {
    const aptRoot = path.posix.resolve("/", reqPath, "../../../../..");
    return Promise.resolve().then(async () => {
      const packagesArray = (await packagesManeger.getPackages(distName, component)).filter(x => ((["all", arch]).includes(x.packageControl.Architecture)));
      const stream = new createAPTPackage(aptRoot, packagesArray);
      if (reqPath.endsWith(".gz")) return stream.pipe(zlib.createGzip()).pipe(res.writeHead(200, {"Content-Type": "application/x-gzip"}));
      else if (reqPath.endsWith(".xz")) return stream.pipe(lzma.Compressor()).pipe(res.writeHead(200, {"Content-Type": "application/x-xz"}));
      else return stream.pipe(res.writeHead(200, {"Content-Type": "text/plain"}));
    }).catch(next);
  });

  // Return router and config
  return {
    app,
    serverConfig,
  };
}