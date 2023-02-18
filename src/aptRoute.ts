import { packagesFunctions } from "./packageStorage.js";
import { aptSConfig } from "./configManeger.js";
import { Debian } from "@sirherobrine23/coreutils";
import { extendsCrypto } from "@sirherobrine23/extends";
import express from "express";
import openpgp from "openpgp";
import stream from "node:stream";
import path from "node:path";
import zlib from "node:zlib";
import lzma from "lzma-native";

export default async function createRoute(serverConfig: aptSConfig, packageManeger: packagesFunctions) {
  const app = express.Router();
  app.use(express.json()).use(express.urlencoded({ extended: true }));
  // Public key
  const pgpKey = serverConfig.server?.pgp;
  app.get("/public(Key|key|_key|_Key)?(.(key|gpg))?", async (_req, res) => {
    if (!pgpKey) return res.status(404).json({ error: "Repository not signed" });
    return res.status(200).setHeader("Content-Type", "application/pgp-keys").send(pgpKey.publicKey);
  });

  // Source.list
  app.get("/source(s)?(((.|_)list)?)", async (req, res) => {
    const remotePath = path.posix.resolve(req.baseUrl + req.path, ".."), protocol = req.headers["x-forwarded-proto"] ?? req.protocol, hostname = process.env["RAILWAY_STATIC_URL"] ?? `${req.hostname}:${req.socket.localPort}`, host = `${protocol}://${hostname}${remotePath}`;
    return res.json({
      remotePath,
      host,
    });
  });

  async function createPackages(options: {stream?: stream.Writable, streamType?: "raw"|"gzip"|"xz", component?: string, arch?: string, appRoot?: string}) {
    const packagesArray = await packageManeger.getPackages(options.component, options.arch);
    if (!packagesArray.length) throw new Error("No packages found");
    if (!options.appRoot) options.appRoot = "/";

    const raw = new stream.Readable({read(){}});
    const gzip = raw.pipe(zlib.createGzip());
    const xz = raw.pipe(lzma.createCompressor());
    if (options.stream) {
      if (options.streamType === "gzip") gzip.pipe(options.stream);
      else if (options.streamType === "xz") xz.pipe(options.stream);
      else raw.pipe(options.stream);
    }
    (async () => {
      packagesArray.forEach(({control}) => {
        control.Filename = path.posix.join(options.appRoot || "/", "pool", control.Filename);
        raw.push(Debian.createControl(control), "binary");
      });
      raw.push(null);
    })();

    return Promise.all([
      extendsCrypto.createHashAsync(raw),
      extendsCrypto.createHashAsync(gzip),
      extendsCrypto.createHashAsync(xz),
    ]).then(([rawHash, gzipHash, xzHash]) => {
      return {
        raw: rawHash,
        gzip: gzipHash,
        xz: xzHash
      }
    });
  }

  app.get("/dists/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?", (req, res, next) => {
    const appRoot = path.posix.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../../..");
    return Promise.resolve().then(async () => {
      const { componentName, Arch } = req.params as any;
      return createPackages({
        appRoot,
        component: componentName,
        arch: Arch,
        streamType: req.path.endsWith(".gz") ? "gzip" : req.path.endsWith(".xz") ? "xz" : "raw",
        stream: res.writeHead(200, {}),
      })
    }).catch(next);
  });

  async function createRelease(distName: string, aptRoot: string, returnObject?: boolean) {
    const { arch, components } = await packageManeger.distInfo(distName);
    if (!arch.length) throw new Error("Architectures not found");
    if (!components.length) throw new Error("Components not found");
    const { aptConfig } = serverConfig.repositorys[distName] ?? {};

    // Origin
    let Origin: string;
    if (aptConfig?.Origin) Origin = aptConfig.Origin;
    else if (serverConfig.globalAptConfig?.Origin) Origin = serverConfig.globalAptConfig.Origin;

    // Lebel
    let Label: string;
    if (aptConfig?.Label) Label = aptConfig.Label;

    // Description
    let Description: string;
    if (aptConfig?.Description) Description = aptConfig.Description.split("\n")[0]?.trim();

    // Version
    let Version: string;
    if (aptConfig?.Version) Version = String(aptConfig.Version).trim();

    // Codename
    let Codename: string;
    if (aptConfig?.Codename) Codename = String(aptConfig.Codename).trim();

    const releaseData: {[keyName: string]: string|(string|{hash: string, size: number, path: string})[]} = {
      Date: new Date().toUTCString(),
      Architectures: arch,
      Components: components,
      Codename,
      Origin,
      Label,
      Version,
      Description,
    };

    if (pgpKey||aptConfig?.enableHashes) {
      const data = (await Promise.all(components.map(async componentName => {
        return Promise.all(arch.map(async archName => {
          const hashs = await createPackages({
            appRoot: aptRoot,
            component: componentName,
            arch: archName,
          });
          return {
            raw: { hash: hashs.raw.hash, size: hashs.raw.byteLength, path: `${componentName}/binary-${archName}/Packages` },
            gz: { hash: hashs.gzip.hash, size: hashs.gzip.byteLength, path: `${componentName}/binary-${archName}/Packages.gz` },
            xz: { hash: hashs.xz.hash, size: hashs.xz.byteLength, path: `${componentName}/binary-${archName}/Packages.xz` }
          }
        }));
      }))).flat(2);
      data.forEach(({ raw, gz, xz }) => {
        releaseData["SHA512"] ??= [];
        if (releaseData["SHA512"] instanceof Array) releaseData["SHA512"].push({ hash: raw.hash.sha512, size: raw.size, path: raw.path }, { hash: gz.hash.sha512, size: gz.size, path: gz.path }, { hash: xz.hash.sha512, size: xz.size, path: xz.path });

        releaseData["SHA256"] ??= [];
        if (releaseData["SHA256"] instanceof Array) releaseData["SHA256"].push({ hash: raw.hash.sha256, size: raw.size, path: raw.path }, { hash: gz.hash.sha256, size: gz.size, path: gz.path }, { hash: xz.hash.sha256, size: xz.size, path: xz.path });

        releaseData["SHA1"] ??= [];
        if (releaseData["SHA1"] instanceof Array) releaseData["SHA1"].push({ hash: raw.hash.sha1, size: raw.size, path: raw.path }, { hash: gz.hash.sha1, size: gz.size, path: gz.path }, { hash: xz.hash.sha1, size: xz.size, path: xz.path });

        releaseData["MD5Sum"] ??= [];
        if (releaseData["MD5Sum"] instanceof Array) releaseData["MD5Sum"].push({ hash: raw.hash.md5, size: raw.size, path: raw.path }, { hash: gz.hash.md5, size: gz.size, path: gz.path }, { hash: xz.hash.md5, size: xz.size, path: xz.path });
      });
    }

    if (returnObject) return releaseData;
    return Object.keys(releaseData).reduce((main, keyName) => {
      let data = releaseData[keyName];
      if (!data) return main;
      if (typeof data === "string") main.push(`${keyName}: ${data}`);
      else if (data instanceof Array) {
        data = data.filter(Boolean);
        if (!data.length) return main;
        main.push(`${keyName}:`);
        for (const line of data) {
          if (typeof line === "string") {
            main[main.length - 1] += ` ${line}`;
          } else main.push(`  ${line.hash} ${line.size} ${line.path}`);
        }
      }
      return main;
    }, [] as string[]).join("\n");

  }

  // List dists
  //  app.get("/dists", async (_req, res, next) => packageManeger.getDists().then(dists => res.status(200).json(dists)).catch(next));
   app.get("/dists/:distName", (req, res, next) => {
     const aptRoot = path.posix.resolve("/", path.posix.join(req.baseUrl, req.path), "..");
     return createRelease(req.params.distName, aptRoot, true).then(release => res.status(200).json(release)).catch(next);
   });
   app.get("/dists/:distName/((InRelease|Release(.gpg)?)?)", (req, res, next) => {
     const aptRoot = path.posix.resolve("/", path.posix.join(req.baseUrl, req.path), "../..");
     return Promise.resolve().then(async () => {
       const Release = await createRelease(req.params.distName, aptRoot) as string;
       if (req.path.endsWith("InRelease")||req.path.endsWith("Release.gpg")) {
         if (!pgpKey) return res.status(404).json({ error: "Repository not signed" });
         const privateKey = pgpKey.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: pgpKey.privateKey }), passphrase: pgpKey.passphrase}) : await openpgp.readPrivateKey({ armoredKey: pgpKey.privateKey });
         res.status(200).setHeader("Content-Type", "text/plain");
         if (req.path.endsWith(".gpg")) return res.send(await openpgp.sign({signingKeys: privateKey, format: "armored", message: await openpgp.createMessage({text: Release})}));
         return res.send(await openpgp.sign({signingKeys: privateKey, format: "armored", message: await openpgp.createCleartextMessage({text: Release})}));
       }
       return res.status(200).setHeader("Content-Type", "text/plain").send(Release);
     }).catch(next);
   });

   // Download package
  app.get("/pool(/:componentName)?(/:packageLetter)?(/:packageName)?(/(:packageNameNull)_(:packageVersion)_(:packageArch)(.deb)?)?", (req, res, next) => {
    const { componentName, packageName, packageVersion, packageArch } = req.params as any;
    let packageLetter = (req.params["packageLetter"] ?? "");
    const isDownload = (componentName?.trim() && packageName?.trim() && packageVersion?.trim() && packageArch?.trim()) && req.path.endsWith(".deb");
    const isPackageInfo = (componentName?.trim() && packageName?.trim() && packageVersion?.trim() && packageArch?.trim()) && !isDownload;
    const isPackageList = componentName?.trim() && packageName?.trim() && !isPackageInfo;
    const isPackageLetter = packageLetter?.trim() && componentName?.trim() && !isPackageList;
    const isComponentList = componentName?.trim() && !isPackageLetter;

    // Send package file
    if (isDownload) return packageManeger.getFile({component: componentName, packageName, version: packageVersion, arch: packageArch}).then(stream => stream.pipe(res.writeHead(200, {"Content-Type": "application/octet-stream"}))).catch(next);
    return Promise.resolve().then(async () => {
      // return data error to fist letter
      if (packageLetter.length > 1) return res.status(400).json({ error: "Package letter must be one character", to: "Package letter" });
      packageLetter = packageLetter[0];

      const packagesArray = (await packageManeger.getPackages()).map(data => {
        delete data.control.Filename;
        return data;
      });
      if (isPackageInfo) {
        const controlData = packagesArray.find(pkg => pkg.component === componentName && pkg.control.Package === packageName && pkg.control.Version === packageVersion && pkg.control.Architecture === packageArch);
        if (!controlData) return res.status(404).json({ error: "Package not found", to: "Package info" });
        return res.status(200).json(controlData.control);
      }

      if (isPackageList) {
        const pkgArray = packagesArray.filter(pkg => pkg.control.Package === packageName && pkg.component === componentName);
        if (!pkgArray.length) return res.status(404).json({ error: "Package not found", to: "Package list", parms: req.params });
        return res.status(200).json(pkgArray.map(pkg => pkg.control));
      }

      if (isPackageLetter) {
        const pkgArray = packagesArray.filter(pkg => pkg.control.Package[0] === packageLetter && pkg.component === componentName);
        if (!pkgArray.length) return res.status(404).json({ error: "Packages not found", to: "Package letter" });
        return res.status(200).json(pkgArray.map(pkg => pkg.control));
      }

      if (isComponentList) {
        const pkgArray = packagesArray.filter(pkg => pkg.component === componentName);
        if (!pkgArray.length) return res.status(404).json({ error: "Component not found" });
        return res.status(200).json(pkgArray.reduce((main, pkg) => {
          if (!main[pkg.control.Package]) main[pkg.control.Package] = [];
          main[pkg.control.Package].push(pkg.control);
          return main;
        }, {}));
      }

      return res.status(200).json(packagesArray.reduce((main, pkg) => {
        if (!main[pkg.component]) main[pkg.component] = {};
        if (!main[pkg.component][pkg.control.Package]) main[pkg.component][pkg.control.Package] = [];
        main[pkg.component][pkg.control.Package].push(pkg.control);
        return main;
      }, {}));
    }).catch(next);
  });

  return app;
}