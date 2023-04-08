import * as Debian from "@sirherobrine23/debian";
import { databaseManeger } from "./packages.js";
import { aptStreamConfig } from "./config.js";
import expressLayer from "express/lib/router/layer.js";
import express from "express";
import path from "node:path";
expressLayer.prototype.handle_request = async function handle_request_promised(...args) {
  var fn = this.handle;
  if (fn.length > 3) return args.at(-1)();
  await Promise.resolve().then(() => fn.call(this, ...args)).catch(args.at(-1));
}

export default function main(packageManeger: databaseManeger, config: aptStreamConfig) {
  const { gpgSign } = config;
  const app = express.Router();

  // Get dists
  app.get("/dists", async ({res}) => res.json(Array.from(new Set(await packageManeger.getResouces().map(d => d.repositoryName)))));

  app.get("/dists(|/.)/:distName(|(/InRelease|/Release(.gpg)?))?", async (req, res) => {
    const lowerPath = req.path.toLowerCase(), aptRoot = path.posix.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../..");
    let Release = await packageManeger.createRelease(req.params["distName"], aptRoot);
    let releaseText: string;
    if (lowerPath.endsWith("inrelease")||lowerPath.endsWith("release.gpg")) {
      if (!gpgSign) return res.status(404).json({ error: "Repository not signed" });
      releaseText = await Release.inRelease(gpgSign, req.path.endsWith(".gpg") ? "sign" : "clearMessage");
    } else if (lowerPath.endsWith("release")) releaseText = Release.toString();
    else return res.json(Release.toJSON());
    return res.status(200).setHeader("Content-Type", "text/plain").setHeader("Content-Length", String(Buffer.byteLength(releaseText))).send(releaseText);
  });

  // app.get("/dists(|/.)/:distName/:componentName/source/Sources", async (req, res) => res.status(404).json({disabled: true, parm: req.params}));
  app.get("/dists(|/.)/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?", async (req, res) => {
    const { distName, componentName, Arch } = req.params;
    const reqPath = req.path;
    packageManeger.createPackage(distName, componentName, Arch, {
      compress: reqPath.endsWith(".gz") ? "gz" : reqPath.endsWith(".xz") ? "xz" : undefined,
      appRoot: path.posix.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../../../.."),
      callback: (str) => str.pipe(res.writeHead(200, {}))
    });
  });

  app.get("/pool", async ({res}) => packageManeger.searchPackages({}).then(data => res.json(data.map(d => d.controlFile))));

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