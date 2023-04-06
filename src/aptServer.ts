import * as Debian from "@sirherobrine23/debian";
import { databaseManeger, dbStorage } from "./packages.js";
import { aptStreamConfig } from "./config.js";
import { extendsCrypto } from "@sirherobrine23/extends";
import expressLayer from "express/lib/router/layer.js";
import express from "express";
import openpgp from "openpgp";
import stream from "node:stream";
import zlib from "node:zlib";
import lzma from "lzma-native";
import path from "node:path/posix";
expressLayer.prototype.handle_request = async function handle_request_promised(...args) {
  var fn = this.handle;
  if (fn.length > 3) return args.at(-1)();
  await Promise.resolve().then(() => fn.call(this, ...args)).catch(args.at(-1));
}

function returnUniq(arg1: string[]) {
  return Array.from(new Set(arg1));
}

class Release {
  readonly Date = new Date().toUTCString();
  constructor() {Object.defineProperty(this, "Date", {writable: false});}
  acquireByHash = false;
  Codename: string;
  Origin: string;
  Label: string;
  Version: string;
  Description: string;
  Architectures = new Set<string>();
  Components = new Set<string>();
  md5 = new Set<{hash: string, size: number, path: string}>();
  SHA1 = new Set<{hash: string, size: number, path: string}>();
  SHA256 = new Set<{hash: string, size: number, path: string}>();
  SHA512 = new Set<{hash: string, size: number, path: string}>();

  toString() {
    if (Array.from(this.Architectures.keys()).length === 0) throw new Error("Set one Arch");
    if (Array.from(this.Components.keys()).length === 0) throw new Error("Set one Component");
    let configString: string[] = [
      "Date: "+(this.Date),
      "Acquire-By-Hash: "+(this.acquireByHash ? "yes" : "no"),
      "Architectures: "+((Array.from(this.Architectures.values())).join(" ")),
      "Components: "+((Array.from(this.Components.values())).join(" ")),
    ];

    if (this.Codename) configString.push(`Codename: ${this.Codename}`);
    if (this.Origin) configString.push(`Origin: ${this.Origin}`);
    if (this.Label) configString.push(`Label: ${this.Label}`);
    if (this.Version) configString.push(`Version: ${this.Version}`);
    if (this.Description) configString.push(`Description: ${this.Description}`);

    const md5Array = Array.from(this.md5.values()).sort((b, a) => a.size - b.size);
    if (md5Array.length > 0) {
      configString.push("MD5Sum:");
      const sizeLength = md5Array.at(0).size.toString().length+2;
      md5Array.forEach(data => configString.push((" "+data.hash + " "+(Array((sizeLength - (data.size.toString().length))).fill("").join(" ")+(data.size.toString()))+" "+data.path)));
    }

    const sha1Array = Array.from(this.SHA1.values()).sort((b, a) => a.size - b.size);
    if (sha1Array.length > 0) {
      configString.push("SHA1:");
      const sizeLength = sha1Array.at(0).size.toString().length+2;
      sha1Array.forEach(data => configString.push((" "+data.hash + " "+(Array((sizeLength - (data.size.toString().length))).fill("").join(" ")+(data.size.toString()))+" "+data.path)));
    }

    const sha256Array = Array.from(this.SHA256.values()).sort((b, a) => a.size - b.size);
    if (sha256Array.length > 0) {
      configString.push("SHA256:");
      const sizeLength = sha256Array.at(0).size.toString().length+2;
      sha256Array.forEach(data => configString.push((" "+data.hash + " "+(Array((sizeLength - (data.size.toString().length))).fill("").join(" ")+(data.size.toString()))+" "+data.path)));
    }

    const sha512Array = Array.from(this.SHA512.values()).sort((b, a) => a.size - b.size);
    if (sha512Array.length > 0) {
      configString.push("SHA512:");
      const sizeLength = sha512Array.at(0).size.toString().length+2;
      sha512Array.forEach(data => configString.push((" "+data.hash + " "+(Array((sizeLength - (data.size.toString().length))).fill("").join(" ")+(data.size.toString()))+" "+data.path)));
    }

    return configString.join("\n");
  }

  toJSON() {
    return {};
  }
}

export default function main(packageManeger: databaseManeger, config: aptStreamConfig) {
  const { gpgSign } = config;
  const app = express.Router();
  async function createPackage(packagesArray: dbStorage[], pathRoot: string, compress?: "gzip"|"lzma", callback: (stream: stream.Readable) => void = () => {}) {
    const __stream = new stream.Readable({read() {}});
    const comp = compress ? __stream.pipe(compress === "lzma" ? lzma.Compressor() : zlib.createGzip()) : null;
    callback(comp ? comp : __stream);
    return Promise.resolve().then(async () => {
      for (let packIndex = 0; packIndex < packagesArray.length; packIndex++) {
        if (packIndex !== 0) __stream.push(Buffer.from("\n\n"));
        const packageComponent = packageManeger.returnSource(packagesArray[packIndex].repositoryID).componentName ?? "main";
        const { controlFile: control } = packagesArray[packIndex];
        const hash = control.SHA1 || control.SHA256 || control.SHA512 || control.MD5sum;
        if (!hash) continue;
        __stream.push(Debian.createControl(Object.assign({
          ...control,
          Filename: path.resolve("/", pathRoot ?? "", "pool", packageComponent, `${hash}.deb`).slice(1),
        })), "utf8");
      }
      __stream.push(null);
      return extendsCrypto.createHashAsync(comp ? comp : __stream);
    });
  }

  async function createRelease(packagesArr: dbStorage[], aptRoot: string) {
    const distName = packageManeger.findRepository(packagesArr.at(0).repositoryID);
    const { aptConfig, source } = config.repository[distName];
    const Rel = new Release();

    // Origin
    if (aptConfig?.Origin) Rel.Origin = aptConfig.Origin;
    else Rel.Origin = distName;

    // Lebel
    if (aptConfig?.Label) Rel.Label = aptConfig.Label;
    else Rel.Label = distName;

    // Codename
    if (aptConfig?.Codename) Rel.Codename = String(aptConfig.Codename).trim();
    else Rel.Codename = distName;

    // Description
    if (aptConfig?.Description) Rel.Description = aptConfig.Description.split("\n")[0]?.trim();

    // Version
    if (aptConfig?.Version) Rel.Version = String(aptConfig.Version).trim();

    const Components = returnUniq(source.map(k => k.componentName ?? "main"));
    const arch = returnUniq(packagesArr.map(k => k.controlFile.Architecture));

    Components.forEach(d => Rel.Components.add(d));
    arch.forEach(d=> Rel.Architectures.add(d));

    await Promise.all(Components.map(async componentName => {
      return Promise.all(arch.map(async archName => {
        const packagesTarget = packagesArr.filter(k => ((packageManeger.returnSource(k.repositoryID).componentName ?? "main") === componentName) && (k.controlFile.Architecture === archName));
        return Promise.all([
          createPackage(packagesTarget, aptRoot).then(data => ({
            hash: data,
            path: `${componentName}/binary-${archName}/Packages`
          })).then(res => {
            Rel.SHA1.add({
              hash: res.hash.hash.sha1,
              path: res.path,
              size: res.hash.byteLength
            });
            Rel.SHA256.add({
              hash: res.hash.hash.sha256,
              path: res.path,
              size: res.hash.byteLength
            });
            Rel.SHA512.add({
              hash: res.hash.hash.sha512,
              path: res.path,
              size: res.hash.byteLength
            });
            Rel.md5.add({
              hash: res.hash.hash.md5,
              path: res.path,
              size: res.hash.byteLength
            });
          }),
          createPackage(packagesTarget, aptRoot, "gzip").then(data => ({
            hash: data,
            path: `${componentName}/binary-${archName}/Packages.gz`
          })).then(res => {
            Rel.SHA1.add({
              hash: res.hash.hash.sha1,
              path: res.path,
              size: res.hash.byteLength
            });
            Rel.SHA256.add({
              hash: res.hash.hash.sha256,
              path: res.path,
              size: res.hash.byteLength
            });
            Rel.SHA512.add({
              hash: res.hash.hash.sha512,
              path: res.path,
              size: res.hash.byteLength
            });
            Rel.md5.add({
              hash: res.hash.hash.md5,
              path: res.path,
              size: res.hash.byteLength
            });
          }),
          createPackage(packagesTarget, aptRoot, "lzma").then(data => ({
            hash: data,
            path: `${componentName}/binary-${archName}/Packages.xz`
          })).then(res => {
            Rel.SHA1.add({
              hash: res.hash.hash.sha1,
              path: res.path,
              size: res.hash.byteLength
            });
            Rel.SHA256.add({
              hash: res.hash.hash.sha256,
              path: res.path,
              size: res.hash.byteLength
            });
            Rel.SHA512.add({
              hash: res.hash.hash.sha512,
              path: res.path,
              size: res.hash.byteLength
            });
            Rel.md5.add({
              hash: res.hash.hash.md5,
              path: res.path,
              size: res.hash.byteLength
            });
          }),
        ]);
      }));
    }));

    return Rel.toString();
  }

  // Get dists
  app.get("/dists", async ({res}) => res.json(Array.from(new Set((await packageManeger.searchPackages({})).map(pkg => packageManeger.findRepository(pkg.repositoryID))))));

  app.get("/dists(|/.)/:distName/((InRelease|Release(.gpg)?))", async (req, res) => {
    const packages = await packageManeger.returnDistPackages(req.params["distName"]);

    if (!packages.length) return res.status(404).json({error: "Distribuition not exsist"});
    let Release = await createRelease(packages, path.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../.."));
    const lowerPath = req.path.toLowerCase();
    if (lowerPath.endsWith("inrelease")||lowerPath.endsWith("release.gpg")) {
      if (!gpgSign) return res.status(404).json({ error: "Repository not signed" });
      const privateKey = gpgSign.authPassword ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: gpgSign.private.content }), passphrase: gpgSign.authPassword}) : await openpgp.readPrivateKey({ armoredKey: gpgSign.private.content });
      if (req.path.endsWith(".gpg")) {
        Release = Buffer.from(await openpgp.sign({
          signingKeys: privateKey,
          format: "armored",
          message: await openpgp.createMessage({
            text: Release
          })
        }) as any).toString("utf8");
      } else Release = await openpgp.sign({signingKeys: privateKey, format: "armored", message: await openpgp.createCleartextMessage({text: Release})})
    }
    return res.status(200).setHeader("Content-Type", "text/plain").setHeader("Content-Length", String(Buffer.byteLength(Release))).send(Release);
  });

  // app.get("/dists(|/.)/:distName/:componentName/source/Sources", async (req, res) => res.status(404).json({disabled: true, parm: req.params}));
  app.get("/dists(|/.)/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?", async (req, res) => {
    const { distName, componentName, Arch } = req.params;
    const src = packageManeger.getConfig().repository[distName]!.source.filter(d => (d.componentName ?? "main") === componentName);
    const packages = await packageManeger.rawSearch({
      repositoryID: src.map(d => d.id) as any,
      controlFile: {
        Architecture: Arch as any,
      }
    });

    if (!packages.length) return res.status(404).json({error: "Distribuition not exsist"});
    return createPackage(packages, path.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../../../.."), req.path.endsWith(".gzip") ? "gzip" : req.path.endsWith(".xz") ? "lzma" : undefined, (str) => str.pipe(res.writeHead(200, {})));
  });

  app.get("/pool", async ({res}) => packageManeger.searchPackages({}).then(data => res.json(data)));

  app.get("/pool/:componentName", async (req, res) => {
    const src = packageManeger.getConfig().repository;
    const packagesList = await packageManeger.rawSearch({
      repositoryID: (Object.keys(src).map(k => src[k].source.map(d => d.id))).flat(2) as any
    });
    if (packagesList.length === 0) return res.status(404).json({error: "Package component not exists"});
    return res.json(packagesList.map(({controlFile, repositoryID}) =>  ({controlFile, repositoryID})));
  });

  app.get("/pool/:componentName/(:hash)(|/data.tar|.deb)", async (req, res, next) => {
    const packageID = (await packageManeger.searchPackages({
      MD5sum: req.params.hash,
      SHA1: req.params.hash,
      SHA256: req.params.hash,
      SHA512: req.params.hash,
    })).at(0);
    if (!packageID) return res.status(404).json({error: "Package not exist"});
    if (req.path.endsWith("/data.tar")||req.path.endsWith(".deb")) {
      const str = await packageManeger.getPackageFile(packageID);
      if (req.path.endsWith(".deb")) return str.pipe(res.writeHead(200, {}));
      return (await Debian.getPackageData(str)).pipe(res.writeHead(200, {}));
    }
    return res.json(packageID.controlFile);
  });
  return app;
}