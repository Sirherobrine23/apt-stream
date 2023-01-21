import { packagesManeger, packageStorage } from "./packageRegister.js";
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
  app.get("/pool(/:componentName)?(/:packageName)?(/:packageArch)?(/:packageVersion)?(/download.deb)?", (req, res, next) => {
    return res.json({
      componentName: req.params.componentName,
      packageName: req.params.packageName,
      packageArch: req.params.packageArch,
      packageVersion: req.params.packageVersion,
    });
  });

  // List dists
  app.get("/dists", async (_req, res, next) => package_maneger.getDists().then(dists => res.status(200).json(dists)).catch(next));

  // Packages
  class PackagesData extends stream.Readable {
    constructor(packages: packageStorage[]) {
      super({read(_size) {}});
      let breakLine = false;
      for (const pkg of packages) {
        const { packageControl } = pkg;
        if (!packageControl.Package) continue;
        else if (!packageControl.Version) continue;
        else if (!packageControl.Architecture) continue;
        else if (!packageControl.Size) continue;
        if (breakLine) this.push("\n"); else breakLine = true;
        this.push(coreUtils.DebianPackage.createControl(packageControl));
      }
      this.push(null);
    }
  }
  app.get("/dists/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?", (req, res, next) => {
    return Promise.resolve().then(async () => {
      const packagesArray = (await package_maneger.getPackages(req.params.distName, req.params.componentName)).filter(pkg => (["all", req.params.Arch] as string[]).includes(pkg.packageControl.Architecture));
      if (!packagesArray.length) return res.status(404).json({ error: "Packages not found" });
      const packagesStream = new PackagesData(packagesArray);
      if (req.path.endsWith(".gz")) return packagesStream.pipe(zlib.createGzip()).pipe(res.writeHead(200, {"Content-Type": "application/gzip"}));
      else if (req.path.endsWith(".xz")) return packagesStream.pipe(lzma.createCompressor()).pipe(res.writeHead(200, {"Content-Type": "application/x-xz"}));
      return packagesStream.pipe(res.writeHead(200, {"Content-Type": "text/plain"}));
    }).catch(next);
  });


  // Release and InRelease
  async function createRelease(distName: string, returnObject?: boolean) {
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

    const releaseData: {[keyName: string]: string|{hash: string, size: number, path: string}[]} = {
      Date: new Date().toUTCString(),
      Architectures: arch.join(" "),
      Components: components.join(" "),
      Codename,
      Origin,
      Label,
      Version,
      Description,
    };

    if (pgpKey||aptConfig?.enableHashes) {
      const allPackagesArray = (await Promise.all(components.map(async componentName => package_maneger.getPackages(distName, componentName)))).flat();
      const data = (await Promise.all(components.map(async componentName => {
        return Promise.all(arch.map(async archName => {
          const packagesArray = allPackagesArray.filter(pkg => (["all", archName] as string[]).includes(pkg.packageControl.Architecture));
          const hashs: ReturnType<typeof coreUtils.extendsCrypto.createHashAsync>[] = [];

          let rawSize = 0;
          const packagesStream = new PackagesData(packagesArray);
          hashs.push(coreUtils.extendsCrypto.createHashAsync(packagesStream));
          packagesStream.on("data", chunk => rawSize += chunk.length);

          let gzSize = 0;
          const gz = packagesStream.pipe(zlib.createGzip());
          hashs.push(coreUtils.extendsCrypto.createHashAsync(gz));
          gz.on("data", chunk => gzSize += chunk.length);

          let xzSize = 0;
          const xz = packagesStream.pipe(lzma.createCompressor());
          hashs.push(coreUtils.extendsCrypto.createHashAsync(xz));
          xz.on("data", chunk => xzSize += chunk.length);

          const [rawHash, gzHash, xzHash] = await Promise.all(hashs);
          return {
            raw: { hash: rawHash, size: rawSize, path: `${componentName}/binary-${archName}/Packages` },
            gz: { hash: gzHash, size: gzSize, path: `${componentName}/binary-${archName}/Packages.gz` },
            xz: { hash: xzHash, size: xzSize, path: `${componentName}/binary-${archName}/Packages.xz` }
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
        for (const { hash, size, path } of data) main.push(`  ${hash} ${size} ${path}`);
      }
      return main;
    }, [] as string[]).join("\n");

  }
  app.get("/dists/:distName", (req, res, next) => createRelease(req.params.distName, true).then(release => res.status(200).json(release)).catch(next));
  app.get("/dists/:distName/((InRelease|Release(.gpg)?)?)", (req, res, next) => {
    return Promise.resolve().then(async () => {
      const Release = await createRelease(req.params.distName) as string;
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