import * as Debian from "@sirherobrine23/debian";
import { packageManeger, packageData } from "./database.js";
import { aptStreamConfig } from "./config.js";
import { extendsCrypto } from "@sirherobrine23/extends";
import { fileRestore } from "./packageManege.js"
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

export default function main(packageManeger: packageManeger, config: aptStreamConfig) {
  const { gpgSign } = config;
  const app = express.Router();
  async function createPackage(packagesArray: packageData[], pathRoot: string, compress?: "gzip"|"lzma", callback: (stream: stream.Readable) => void = () => {}) {
    const __stream = new stream.Readable({read() {}});
    const comp = compress ? __stream.pipe(compress === "lzma" ? lzma.Compressor() : zlib.createGzip()) : null;
    callback(comp ? comp : __stream);
    return Promise.resolve().then(async () => {
      for (let packIndex = 0; packIndex < packagesArray.length; packIndex++) {
        if (packIndex !== 0) __stream.push(Buffer.from("\n\n"));
        const { packageControl: control, packageComponent } = packagesArray[packIndex];
        const hash = control.SHA1 || control.SHA256 || control.SHA512 || control.MD5sum;
        if (!hash) continue;
        __stream.push(Debian.createControl(Object.assign({
          ...control,
          Filename: path.resolve("/", pathRoot ?? "", "pool", packageComponent ?? "main", `${hash}.deb`).slice(1),
        })), "utf8");
      }
      __stream.push(null);
      return extendsCrypto.createHashAsync(comp ? comp : __stream);
    });
  }

  async function createRelease(packagesArr: packageData[], aptRoot: string) {
    const { aptConfig } = config.repository[packagesArr.at(-1).packageDistribuition] ?? {};
    // Origin
    let Origin: string;
    if (aptConfig?.Origin) Origin = aptConfig.Origin;

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

    const Components = returnUniq(packagesArr.map(k => k.packageComponent));
    const arch = returnUniq(packagesArr.map(k => k.packageControl.Architecture));
    const releaseData: {[keyName: string]: string|(string|{hash: string, size: number, path: string})[]} = {
      Date: new Date().toUTCString(),
      Architectures: arch,
      Components,
      Codename,
      Origin,
      Label,
      Version,
      Description,
    };

    const data = (await Promise.all(Components.map(async componentName => {
      return Promise.all(arch.map(async archName => {
        const packagesTarget = packagesArr.filter(k => (k.packageComponent === componentName) && (k.packageControl.Architecture === archName));
        return Promise.all([
          createPackage(packagesTarget, aptRoot).then(data => ({
            hash: data,
            path: `${componentName}/binary-${archName}/Packages`
          })),
          createPackage(packagesTarget, aptRoot, "gzip").then(data => ({
            hash: data,
            path: `${componentName}/binary-${archName}/Packages.gz`
          })),
          createPackage(packagesTarget, aptRoot, "lzma").then(data => ({
            hash: data,
            path: `${componentName}/binary-${archName}/Packages.xz`
          })),
        ]);
      }));
    }))).flat(3);

    data.forEach(({ path, hash: {byteLength, hash} }) => {
      for (let t in hash) {
        const d: string = hash[t];
        if (t === "md5") t = "MD5Sum";
        else t = t.toUpperCase();
        releaseData[t] ??= [];
        (releaseData[t] as any[]).push({
          hash: d,
          size: byteLength,
          path
        });
      }
    });

    return Object.keys(releaseData).reduce((main, keyName) => {
      let data = releaseData[keyName];
      if (!data) return main;
      if (typeof data === "string") main.push(`${keyName}: ${data}`);
      else if (data instanceof Array) {
        data = data.filter(Boolean);
        if (!data.length) return main;
        main.push(`${keyName}:`);
        // data.sort((a, b) => {
        //   if (typeof a === "string") return 0;
        //   else if (typeof b === "string") return 0;
        //   return b.size - a.size;
        // });
        for (const line of data) {
          if (typeof line === "string") {
            main[main.length - 1] += ` ${line}`;
          } else main.push(`  ${line.hash} ${line.size} ${line.path}`);
        }
      }
      return main;
    }, [] as string[]).join("\n");
  }

  // Get dists
  app.get("/dists", async ({res}) => res.json(Array.from(new Set((await packageManeger.search()).map(pkg => pkg.packageDistribuition)))));
  app.get("/dists(|/.)/:distName/((InRelease|Release(.gpg)?))", async (req, res) => {
    const packages = await packageManeger.search({packageDist: req.params["distName"]});
    if (!packages.length) return res.status(404).json({error: "Distribuition not exsist"});
    let Release = await createRelease(packages, path.resolve("/", path.posix.join(req.baseUrl, req.path), "../../.."));
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

  app.get("/dists(|/.)/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?", async (req, res) => {
    const { distName, componentName, Arch } = req.params;
    const packages = await packageManeger.search({packageDist: distName, packageComponent: componentName, packageArch: Arch});
    if (!packages.length) return res.status(404).json({error: "Distribuition not exsist"});
    return createPackage(packages, path.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../../.."), req.path.endsWith(".gzip") ? "gzip" : req.path.endsWith(".xz") ? "lzma" : undefined, (str) => str.pipe(res.writeHead(200, {})));
  });
  app.get("/dists(|/.)/:distName/:componentName/source/Sources", async (req, res) => res.status(404).json({disabled: true, parm: req.params}));
  app.get("/pool", async ({res}) => packageManeger.search({}).then(data => res.json(data)));
  app.get("/pool/:componentName", async (req, res) => {
    const packagesList = await packageManeger.search({packageComponent: req.params.componentName});
    if (packagesList.length === 0) return res.status(404).json({error: "Package component not exists"});
    return res.json(packagesList.map(({packageControl, packageDistribuition}) =>  ({control: packageControl, dist: packageDistribuition})));
  });
  app.get("/pool/:componentName/(:hash)(|/data.tar|.deb)", async (req, res, next) => {
    const packageID = (await packageManeger.search({packageComponent: req.params.componentName})).find(({packageControl}) => ([String(packageControl.SHA1), String(packageControl.SHA256), String(packageControl.SHA512), String(packageControl.MD5sum)]).includes(req.params.hash));
    if (!packageID) return res.status(404).json({error: "Package not exist"});
    if (req.path.endsWith("/data.tar")||req.path.endsWith(".deb")) {
      const str = await fileRestore(packageID, config);
      if (req.path.endsWith(".deb")) return str.pipe(res.writeHead(200, {}));
      return (await Debian.getPackageData(str)).pipe(res.writeHead(200, {}));
    }
    return res.json(packageID.packageControl);
  });
  return app;
}