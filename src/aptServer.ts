import * as Debian from "@sirherobrine23/debian";
import { packageManeger, packageData } from "./database.js";
import { aptStreamConfig } from "./config.js";
import { extendsCrypto } from "@sirherobrine23/extends";
import express from "express";
import stream from "node:stream";
import openpgp from "openpgp";
import zlib from "node:zlib";
import lzma from "lzma-native";
import path from "node:path/posix";

function returnUniq(arg1: string[]) {
  return Array.from(new Set(arg1));
}

export default function main(packageManeger: packageManeger, config: aptStreamConfig) {
  const { gpgSign } = config;
  const app = express.Router();

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
        for (const line of data) {
          if (typeof line === "string") {
            main[main.length - 1] += ` ${line}`;
          } else main.push(`  ${line.hash} ${line.size} ${line.path}`);
        }
      }
      return main;
    }, [] as string[]).join("\n");
  }

  function createPackage(packagesArray: packageData[], pathRoot: string, compress?: "gzip"|"lzma") {
    const __stream = new stream.Readable({read() {}});
    const comp = compress ? __stream.pipe(compress === "lzma" ? lzma.Compressor() : zlib.createGzip()) : null;
    const __load = Promise.resolve().then(async () => {
      for (let packIndex = 0; packIndex < packagesArray.length; packIndex++) {
        if (packIndex !== 0) __stream.push(Buffer.from("\n\n"));
        const { packageControl: control, packageComponent } = packagesArray[packIndex];
        __stream.push(Debian.createControl(Object.assign({
          ...control,
          Filename: path.resolve("/", pathRoot ?? "", "pool", packageComponent ?? "main", `${control.Package}_${control.Architecture}_${control.Version}.deb`),
        })));
      }
      return extendsCrypto.createHashAsync(comp ? comp : __stream);
    });
    return Object.assign(comp ? comp : __stream, __load);
  }

  app.get("/dists/:distName/((InRelease|Release(.gpg)?))", async (req, res) => {
    const packages = await packageManeger.search({packageDist: req.params["distName"]});
    if (!packages.length) return res.status(404).json({error: "Distribuition not exsist"});
    const Release = await createRelease(packages, path.resolve("/", path.posix.join(req.baseUrl, req.path), "../../.."));
    if (req.path.endsWith("InRelease")||req.path.endsWith("Release.gpg")) {
      if (!gpgSign) return res.status(404).json({ error: "Repository not signed" });
      const privateKey = gpgSign.authPassword ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: gpgSign.private.content }), passphrase: gpgSign.authPassword}) : await openpgp.readPrivateKey({ armoredKey: gpgSign.private.content });
      res.status(200).setHeader("Content-Type", "text/plain");
      if (req.path.endsWith(".gpg")) return res.send(await openpgp.sign({
        signingKeys: privateKey,
        format: "armored",
        message: await openpgp.createMessage({
          text: Release
        })
      }));
      return res.send(await openpgp.sign({signingKeys: privateKey, format: "armored", message: await openpgp.createCleartextMessage({text: Release})}));
    }
    return res.status(200).setHeader("Content-Type", "text/plain").send(Release);
  });

  app.get("/dists/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?", async (req, res) => {
    const { distName, componentName, Arch } = req.params;
    const packages = await packageManeger.search({packageDist: distName, packageComponent: componentName, packageArch: Arch});
    if (!packages.length) return res.status(404).json({error: "Distribuition not exsist"});
    return createPackage(packages, path.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../../.."), req.path.endsWith(".gzip") ? "gzip" : req.path.endsWith(".xz") ? "lzma" : undefined).pipe(res.writeHead(200, {
    }));
  });

  return app;
}