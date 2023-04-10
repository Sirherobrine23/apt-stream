import * as Debian from "@sirherobrine23/debian";
import { packageManeger } from "./packages.js";
import express, { ErrorRequestHandler } from "express";
import expressLayer from "express/lib/router/layer.js";
import cluster from "node:cluster";
import path from "node:path";

expressLayer.prototype.handle_request = async function handle_request_promised(...args) {
  var fn = this.handle;
  if (fn.length > 3) return args.at(-1)();
  await Promise.resolve().then(() => fn.call(this, ...args)).catch(args.at(-1));
}

export default async function main(packageManeger: packageManeger) {
  const app = express(), aptRoute = express.Router();
  app.use((_req, res, next) => {res.json = (body) => res.setHeader("Content-Type", "application/json").send(JSON.stringify(body, null, 2)); return next();});
  app.get("/", ({res}) => res.json({cluster: cluster.worker?.id ?? 0}));
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