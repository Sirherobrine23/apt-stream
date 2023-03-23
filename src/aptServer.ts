import * as Debian from "@sirherobrine23/debian";
import { packageManeger, packageData } from "./database.js";
import { extendsCrypto } from "@sirherobrine23/extends";
import express from "express";
import stream from "node:stream";
import zlib from "node:zlib";
import lzma from "lzma-native";
import path from "node:path/posix";

// async function createRelease() {}

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

export default function main(packageManeger: packageManeger) {
  const app = express.Router();

  app.get("/dists/:distName/((InRelease|Release(.gpg)?)?)", async (req, res) => {
    const packages = await packageManeger.search({packageDist: req.params["distName"]});
    if (!packages.length) return res.status(404).json({error: "Distribuition not exsist"});
    return res.json(packages);
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