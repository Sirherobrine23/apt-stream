import * as Debian from "@sirherobrine23/debian";
import { packageManeger } from "./packages.js";
import express, { ErrorRequestHandler } from "express";
import streamPromise from "node:stream/promises";
import expressLayer from "express/lib/router/layer.js";
import cluster from "node:cluster";
import crypto from "node:crypto";
import path from "node:path";

expressLayer.prototype.handle_request = async function handle_request_promised(...args) {
  var fn = this.handle;
  if (fn.length > 3) return args.at(-1)();
  await Promise.resolve().then(() => fn.call(this, ...args)).catch(args.at(-1));
}

export default async function main(packageManeger: packageManeger) {
  const app = express(), aptRoute = express.Router();
  app.use(express.json(), (_req, res, next) => {res.json = (body) => res.setHeader("Content-Type", "application/json").send(JSON.stringify(body, null, 2)); return next();});

  app.get("/", async ({res}) => res.json({
    cluster: cluster.worker?.id ?? 0,
    sourcesCount: packageManeger.getRepositorys().length,
    packagesRegistred: await packageManeger.packagesCount()
  }));

  // Public key
  app.get("/public(_key|)(|.gpg|.dearmor)", async (req, res) => res.setHeader("Content-Type", req.path.endsWith(".dearmor") ? "octect/stream" : "text/plain").send(await packageManeger.getPublicKey(req.path.endsWith(".dearmor") ? "dearmor" : "armor")));

  // Get dists
  aptRoute.get("/dists", async ({res}) => res.json(Array.from(new Set(packageManeger.getRepositorys().map(d => d.repositoryName)))));
  aptRoute.get("/dists/(:distName)(|/InRelease|/Release(.gpg)?)?", async (req, res) => {
    const lowerPath = req.path.toLowerCase(), aptRoot = path.posix.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../..");
    let Release = await packageManeger.createRelease(req.params["distName"], aptRoot);
    let releaseText: string;
    if (lowerPath.endsWith("inrelease")||lowerPath.endsWith("release.gpg")) releaseText = await Release.inRelease(req.path.endsWith(".gpg") ? "clearMessage" : "sign");
    else if (lowerPath.endsWith("release")) releaseText = Release.toString();
    else return res.json(Release.toJSON());
    return res.status(200).setHeader("Content-Type", "text/plain").setHeader("Content-Length", String(Buffer.byteLength(releaseText))).send(releaseText);
  });

  aptRoute.get("/dists/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?", async (req, res) => {
    const { distName, componentName, Arch } = req.params;
    const reqPath = req.path;
    return packageManeger.createPackage(distName, componentName, Arch, path.posix.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../../../.."), {
      compress: reqPath.endsWith(".gz") ? "gz" : reqPath.endsWith(".xz") ? "xz" : undefined,
      callback: (str) => str.pipe(res.writeHead(200, {}))
    });
  });

  aptRoute.get("/pool", async ({res}) => packageManeger.pkgQuery({}).then(data => res.json(data.map(d => d.controlFile))));
  aptRoute.get("/pool/:componentName", async (req, res) => {
    const src = packageManeger.getRepositorys().map(src => src.repositoryManeger.getAllRepositorys()).flat(2).filter(d => d.componentName === req.params.componentName);
    if (!src.length) return res.status(404).json({error: "No component with this name"});
    const packagesList = (await Promise.all(src.map(async ({repositoryID}) => packageManeger.pkgQuery({repositoryID})))).flat(3);
    if (!packagesList.length) return res.status(404).json({error: "Package component not exists"});
    return res.json(packagesList.map(({controlFile, repositoryID}) =>  ({controlFile, repositoryID})));
  });

  aptRoute.get("/pool/:componentName/(:hash)(|/data.tar|.deb)", async (req, res) => {
    const packageID = (await packageManeger.pkgQuery({"controlFile.SHA1": req.params.hash})).at(0);
    if (!packageID) return res.status(404).json({error: "Package not exist"});
    if (req.path.endsWith("/data.tar")||req.path.endsWith(".deb")) {
      const str = await packageManeger.getPackageStream(packageID);
      if (req.path.endsWith(".deb")) return str.pipe(res.writeHead(200, {}));
      return (await Debian.getPackageData(str)).pipe(res.writeHead(200, {}));
    }
    return res.json(packageID.controlFile);
  });


  // Upload file
  const uploadIDs: {[id: string]: {createAt: Date, deleteAt: Date, uploading: boolean, repositoryID: string, filename: string}} = {};
  const uploadRoute = express.Router(); aptRoute.use("/upload", uploadRoute);
  uploadRoute.all("*", ({res}) => res.status(404).json({message: "Disable to implement's"}));
  uploadRoute.get("/", ({res}) => res.json({available: true}));
  uploadRoute.post("/", ({body}, res) => {
    if (!body) return res.status(400).json({error: "Required JSON or YAML to set up upload"});
    const { repositoryID, control } = body as {repositoryID: string, control: Debian.debianControl};
    if (!repositoryID) return res.status(400).json({error: "Required repository ID"});
    if (!control) return res.status(400).json({error: "Required debian control JSON"});
    const repo = packageManeger.getRepository(repositoryID).get(repositoryID);
    if (!repo.enableUpload) return res.status(401).json({message: "This repository not support upload or not setup to Upload files!"});
    let reqID: string;
    while (true) if (!(uploadIDs[(reqID = crypto.randomBytes(8).toString("hex"))])) break;
    const { Package: packageName, Architecture, Version } = control;
    const createAt = new Date(), deleteAt = new Date(createAt.getTime() + (1000 * 60 * 5));
    setTimeout(() => delete uploadIDs[reqID], createAt.getTime() - deleteAt.getTime())
    uploadIDs[reqID] = {
      createAt, deleteAt,
      repositoryID,
      uploading: false,
      filename: `${packageName}_${Architecture}_${Version}.deb`,
    };
    return res.status(201).json({
      repositoryType: repo.type,
      uploadID: reqID,
      config: uploadIDs[reqID]
    });
  });
  uploadRoute.put("/:uploadID", async (req, res) => {
    if (!(uploadIDs[req.params.uploadID])) return res.status(401).json({error: "Create uploadID fist!"});
    if (uploadIDs[req.params.uploadID].uploading) return res.status(401).json({error: "Create new uploadID, this in use"});
    else if (!(req.headers["content-type"].includes("application/octet-stream"))) return res.status(400).json({error: "Send octet stream file"});
    else if (!(req.headers["content-length"])) return res.status(422).json({error: "Required file size"});
    else if (Number(req.headers["content-length"]) < 10) return res.status(422).json({error: "The file too small!"});
    uploadIDs[req.params.uploadID].uploading = true;
    let { repositoryID, filename } = uploadIDs[req.params.uploadID];

    try {
      const up = await packageManeger.getRepository(repositoryID).uploadFile(repositoryID);
      if (up.githubUpload) {
        const tagName = (Array.isArray(req.query.tagName) ? req.query.tagName.at(0).toString() : req.query.tagName.toString());
        if (!tagName) res.setHeader("warning", "Using latest github release tag!");
        await streamPromise.finished(req.pipe(await up.githubUpload(filename, Number(req.headers["content-length"]), tagName)));
        return res.status(201).json({type: "Github release"});
      } else if (up.gdriveUpload) {
        const id = (Array.isArray(req.query.id) ? req.query.id.at(0).toString() : req.query.id.toString());
        await streamPromise.finished(req.pipe(await up.gdriveUpload(filename, id)));
        return res.status(201).json({type: "Google driver"});
      } else if (up.ociUpload) {
        if (typeof req.query.path === "string") filename = path.posix.resolve("/", req.query.path, filename);
        await streamPromise.finished(req.pipe(await up.ociUpload(filename)));
        return res.status(201).json({type: "Oracle cloud bucket"});
      }
      return res.status(502).json({
        message: "Sorry, our error was caught"
      });
    } finally {
      delete uploadIDs[req.params.uploadID];
    }
  });

  app.use(aptRoute);
  app.use("/apt", aptRoute);

  app.all("*", ({res}) => res.status(404).json({message: "Page not exists"}));
  const errHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    return res.status(400).json({error: err?.message || String(err)});
  };
  app.use(errHandler).listen(packageManeger.getPortListen(), function () {
    const address = this.address();
    console.log("Port Listen on %O", typeof address === "object" ? address.port : address);
  });
}