import { packagesManeger } from "./packageRegister.js";
import { aptSConfig } from "./configManeger.js";
import coreUtils from "@sirherobrine23/coreutils";
import express from "express";
import openpgp from "openpgp";
import stream from "node:stream";
import path from "node:path";
import zlib from "node:zlib";
import lzma from "lzma-native";

export default createRouters;
export async function createRouters(package_maneger: packagesManeger, server_config: aptSConfig) {
  const app = express.Router();
  app.use(express.json()).use(express.urlencoded({ extended: true }));

  // Public key
  const pgpKey = server_config.server?.pgp;
  app.get("/public(Key|key|_key|_Key)?(.(key|gpg))?", async (_req, res) => {
    if (!pgpKey) return res.status(404).json({ error: "Repository not signed" });
    return res.status(200).setHeader("Content-Type", "application/pgp-keys").send(pgpKey.publicKey);
  });

  // Source.list
  app.get("/source(s)?(((.|_)list)?)", async (req, res) => {
    const remotePath = path.posix.resolve(req.baseUrl + req.path, ".."), protocol = req.headers["x-forwarded-proto"] ?? req.protocol, hostname = process.env["RAILWAY_STATIC_URL"] ?? `${req.hostname}:${req.socket.localPort}`, host = `${protocol}://${hostname}${remotePath}`;
    const data = await Promise.all((await package_maneger.getDists()).map(async dist => package_maneger.getDistInfo(dist).then(data => ({...data, dist}))));
    if (!data.length) return res.status(400).json({ error: "Apt-stream not configured" });
    return res.status(200).setHeader("Content-Type", "text/plain").send(data.map(data => `deb ${host} ${data.dist} ${data.components.join(" ")}`).join("\n"));
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
    if (isDownload) return package_maneger.getFileStream({component: componentName, packageName, version: packageVersion, arch: packageArch}).then(stream => stream.pipe(res.writeHead(200, {"Content-Type": "application/octet-stream"}))).catch(next);
    return Promise.resolve().then(async () => {
      // return data error to fist letter
      if (packageLetter.length > 1) return res.status(400).json({ error: "Package letter must be one character", to: "Package letter" });
      packageLetter = packageLetter[0];

      const packagesArray = (await package_maneger.getPackages()).map(data => {
        delete data.packageControl.Filename;
        return data;
      });
      if (isPackageInfo) {
        const controlData = packagesArray.find(pkg => pkg.component === componentName && pkg.packageControl.Package === packageName && pkg.packageControl.Version === packageVersion && pkg.packageControl.Architecture === packageArch);
        if (!controlData) return res.status(404).json({ error: "Package not found", to: "Package info" });
        return res.status(200).json(controlData.packageControl);
      }

      if (isPackageList) {
        const pkgArray = packagesArray.filter(pkg => pkg.packageControl.Package === packageName && pkg.component === componentName);
        if (!pkgArray.length) return res.status(404).json({ error: "Package not found", to: "Package list", parms: req.params });
        return res.status(200).json(pkgArray.map(pkg => pkg.packageControl));
      }

      if (isPackageLetter) {
        const pkgArray = packagesArray.filter(pkg => pkg.packageControl.Package[0] === packageLetter && pkg.component === componentName);
        if (!pkgArray.length) return res.status(404).json({ error: "Packages not found", to: "Package letter" });
        return res.status(200).json(pkgArray.map(pkg => pkg.packageControl));
      }

      if (isComponentList) {
        const pkgArray = packagesArray.filter(pkg => pkg.component === componentName);
        if (!pkgArray.length) return res.status(404).json({ error: "Component not found" });
        return res.status(200).json(pkgArray.reduce((main, pkg) => {
          if (!main[pkg.packageControl.Package]) main[pkg.packageControl.Package] = [];
          main[pkg.packageControl.Package].push(pkg.packageControl);
          return main;
        }, {}));
      }

      return res.status(200).json(packagesArray.reduce((main, pkg) => {
        if (!main[pkg.component]) main[pkg.component] = {};
        if (!main[pkg.component][pkg.packageControl.Package]) main[pkg.component][pkg.packageControl.Package] = [];
        main[pkg.component][pkg.packageControl.Package].push(pkg.packageControl);
        return main;
      }, {}));
    }).catch(next);
  });

  // Packages stream
  async function PackagesData(distName: string, componentName: string, packageArch: string, rootFolder?: string): Promise<stream.Readable> {
    const packagesArray = (await package_maneger.getPackages(distName, componentName)).filter(pkg => (["all", packageArch] as string[]).includes(pkg.packageControl.Architecture));
    if (!packagesArray.length) return Promise.reject(new Error("Packages not found"));
    return new stream.Readable({
      read() {},
      construct(callback) {
        if (callback) callback();
        for (const pkg of packagesArray) {
          pkg.packageControl.Filename = path.posix.resolve("/", rootFolder ?? "", "pool", pkg.component, pkg.packageControl.Package[0], pkg.packageControl.Package, `${pkg.packageControl.Package}_${pkg.packageControl.Version}_${pkg.packageControl.Architecture}.deb`).slice(1);
          this.push(coreUtils.DebianPackage.createControl(pkg.packageControl));
        }
        this.push(null);
      },
    })
  }
  app.get("/dists/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?", (req, res, next) => {
    const aptRoot = path.posix.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../../..");
    return Promise.resolve().then(async () => {
      const { distName, componentName, Arch } = req.params as any;
      if (req.path.endsWith(".gz")) return (await PackagesData(distName, componentName, Arch, aptRoot)).pipe(zlib.createGzip()).pipe(res.writeHead(200, {"Content-Type": "application/gzip"}));
      else if (req.path.endsWith(".xz")) return (await PackagesData(distName, componentName, Arch, aptRoot)).pipe(lzma.createCompressor()).pipe(res.writeHead(200, {"Content-Type": "application/x-xz"}));
      return (await PackagesData(distName, componentName, Arch, aptRoot)).pipe(res.writeHead(200, {"Content-Type": "text/plain"}));
    }).catch(next);
  });


  // Release and InRelease
  async function createRelease(distName: string, aptRoot: string, returnObject?: boolean) {
    const { arch, components } = await package_maneger.getDistInfo(distName);
    if (!arch.length) throw new Error("Architectures not found");
    if (!components.length) throw new Error("Components not found");
    const { aptConfig } = server_config.repositorys[distName] ?? {};

    // Origin
    let Origin: string;
    if (aptConfig?.Origin) Origin = aptConfig.Origin;
    else if (server_config.globalAptConfig?.Origin) Origin = server_config.globalAptConfig.Origin;

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
          const packagesStream = await PackagesData(distName, componentName, archName);
          const [rawHash, gzHash, xzHash] = await Promise.all([
            coreUtils.extendsCrypto.createHashAsync(packagesStream),
            coreUtils.extendsCrypto.createHashAsync(packagesStream.pipe(zlib.createGzip())),
            coreUtils.extendsCrypto.createHashAsync(packagesStream.pipe(lzma.createCompressor())),
          ]);

          return {
            raw: { hash: rawHash.hash, size: rawHash.dataReceived, path: `${componentName}/binary-${archName}/Packages` },
            gz: { hash: gzHash.hash, size: gzHash.dataReceived, path: `${componentName}/binary-${archName}/Packages.gz` },
            xz: { hash: xzHash.hash, size: xzHash.dataReceived, path: `${componentName}/binary-${archName}/Packages.xz` }
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
  app.get("/dists", async (_req, res, next) => package_maneger.getDists().then(dists => res.status(200).json(dists)).catch(next));
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

  // Return router and config
  return app;
}