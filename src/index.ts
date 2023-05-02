#!/usr/bin/env node
import "./log.js";
import path from "node:path";
import yargs from "yargs";
import crypto from "node:crypto";
import cluster from "node:cluster";
import packages from "./packages.js";
import express from "express";
import expressRate from "express-rate-limit";
import streamPromise from "node:stream/promises";
import configManeger from "./configManeger.js";
import * as Debian from "@sirherobrine23/dpkg";
import oldFs, { createReadStream, promises as fs } from "node:fs";
import { aptStreamConfig } from "./config.js";
import { dockerRegistry } from "@sirherobrine23/docker-registry";
import { extendsFS } from "@sirherobrine23/extends";
import { dpkg } from "@sirherobrine23/dpkg";

// Set yargs config
const terminalSize = typeof process.stdout.getWindowSize === "function" ? process.stdout.getWindowSize()[0] : null;
yargs(process.argv.slice(2)).wrap(terminalSize).version(false).help(true).alias("h", "help").strictCommands().demandCommand()

// Edit/print configs interactive mode
.command(["config", "maneger", "$0"], "Maneger config", yargs => yargs.option("config", {
  string: true,
  alias: "c",
  type: "string",
  description: "Config file path",
  default: "aptStream.yml",
}).option("print", {
  description: "print config in stdout and select targets to print. Default is yaml",
  alias: "p",
  array: false,
  string: true,
  choices: [
    "",                             // if set only "--print"
    "yaml",    "yml",    "json",    // without encode
    "yaml64",  "yml64",  "json64",  // Encode in base64
    "yamlhex", "ymlhex", "jsonhex", // encode in hexadecimal (hex)
  ],
}), async options => {
  if (options.print !== undefined) {
    let out = String(options.print);
    if (typeof options.print === "boolean"||options.print === "") out = "yaml";
    const config = new aptStreamConfig(options.config);
    const target = out.startsWith("json") ? "json" : "yaml", encode = out.endsWith("64") ? "base64" : out.endsWith("hex") ? "hex" : "utf8";
    return console.log((config.toString(encode, target)));
  }
  if (!process.stdin.isTTY) throw new Error("Run with TTY to maneger config!");
  return configManeger(options.config);
})

// Sync repository packages
.command(["sync", "synchronize"], "Sync packges directly from CLI", yargs => yargs.option("config", {
  string: true,
  alias: "c",
  type: "string",
  description: "Config file path",
  default: "aptStream.yml",
}).option("verbose", {
  type: "boolean",
  boolean: true,
  description: "Enable verbose errors",
  default: false,
  alias: ["v", "vv", "dd"]
}), async options => {
  console.log("Starting...");
  const packageManeger = await packages(options.config);
  await packageManeger.syncRepositorys((err, db) => {
    if (!!err) {
      if (options.verbose) return console.error(err);
      return console.error(err.message || err);
    }
    console.log("Added %s: %s/%s (%s)", db.repositoryID, db.controlFile.Package, db.controlFile.Architecture, db.controlFile.Version);
  });
  console.log("End!");
  return packageManeger.close();
})

// Pack debian package
.command(["pack", "pack-deb", "create", "c"], "Create package", yargs => yargs.option("package-path", {
  type: "string",
  string: true,
  alias: "s",
  default: process.cwd(),
  description: "Debian package source",
}).option("output", {
  type: "string",
  string: true,
  alias: "o",
}).option("compress", {
  type: "string",
  string: true,
  alias: [
    "data-compress",
    "c"
  ],
  description: "data.tar compress file",
  default: "gzip",
  choices: [
    "passThrough",
    "gzip",
    "zst",
    "xz",
  ]
}).option("control-compress", {
  type: "string",
  string: true,
  description: "control.tar compress file",
  alias: [
    "d"
  ],
  default: "gzip",
  choices: [
    "gzip",
    "passThrough",
    "xz"
  ]
}), async options => {
  let debianConfig: string;
  if (!(await extendsFS.exists(debianConfig = path.resolve(process.cwd(), options.packagePath, "DEBIAN"))||await extendsFS.exists(debianConfig = path.resolve(process.cwd(), options.packagePath, "debian")))) throw new Error("Create valid package Structure!");
  if (!(await extendsFS.exists(path.join(debianConfig, "control")))) throw new Error("Require control file");
  const control = dpkg.parseControl(await fs.readFile(path.join(debianConfig, "control")));
  if (!options.output) options.output = path.join(process.cwd(), `${control.Package}_${control.Architecture}_${control.Version}.deb`); else options.output = path.resolve(process.cwd(), options.output);
  const scriptsFile = (await fs.readdir(debianConfig)).filter(file => (["preinst", "prerm", "postinst", "postrm"]).includes(file));

  console.log("Creating debian package");
  await streamPromise.finished(dpkg.createPackage({
    control,
    dataFolder: path.resolve(debianConfig, ".."),
    compress: {
      data: options.compress as any||"gzip",
      control: options.controlCompress as any||"gzip",
    },
    scripts: scriptsFile.reduce<dpkg.packageConfig["scripts"]>((acc, file) => {acc[file] = path.join(debianConfig, file); return acc;}, {})
  }).pipe(oldFs.createWriteStream(options.output)));
  console.log("File saved %O", options.output);
})

// Upload to registry
.command(["upload", "u"], "Upload package to repoitory allow uploads", yargs => yargs.strictCommands(false).option("config", {
  string: true,
  alias: "c",
  type: "string",
  description: "Config file path",
  default: "aptStream.yml",
}).option("repositoryID", {
  type: "string",
  string: true,
  alias: ["repoID", "id", "i"],
  demandOption: true,
  description: "Repository to upload files"
}).option("tag", {
  type: "string",
  string: true,
  description: "Docker/Github release tag name",
  alias: ["dockerTAG", "ociTAG", "oci_tag", "release_tag"]
}), async options => {
  const files = options._.slice(1).map((file: string) => path.resolve(process.cwd(), file));
  if (!files.length) throw new Error("Required one file to Upload");
  const config = new aptStreamConfig(options.config);
  if (!(config.getRepository(options.repositoryID).get(options.repositoryID)).enableUpload) throw new Error("Repository not support upload file!");
  const up = await config.getRepository(options.repositoryID).uploadFile(options.repositoryID);
  if (up.githubUpload) {
    for (const filePath of files) {
      if (!(await extendsFS.exists(filePath))) {console.error("%O not exsists!"); continue;}
      const stats = await fs.lstat(filePath);
      const filename = path.basename(filePath);
      await streamPromise.finished(createReadStream(filePath).pipe(await up.githubUpload(filename, stats.size, options.tag)));
    }
  } else if (up.gdriveUpload) {
    for (const filePath of files) {
      if (!(await extendsFS.exists(filePath))) {console.error("%O not exsists!"); continue;}
      const filename = path.basename(filePath);
      await streamPromise.finished(createReadStream(filePath).pipe(await up.gdriveUpload(filename)));
    }
  } else if (up.ociUpload) {
    for (const filePath of files) {
      if (!(await extendsFS.exists(filePath))) {console.error("%O not exsists!"); continue;}
      const filename = path.basename(filePath);
      await streamPromise.finished(createReadStream(filePath).pipe(await up.ociUpload(filename)));
    }
  } else if (up.dockerUpload) {
    for (const filePath of files) {
      if (!(await extendsFS.exists(filePath))) {console.error("%O not exsists!"); continue;}
      const { controlFile } = await dpkg.parsePackage(createReadStream(filePath));
      const filename = path.basename(filePath);
      const tr = await up.dockerUpload(dockerRegistry.debianArchToDockerPlatform(controlFile.Architecture));
      tr.annotations.set("org.opencontainers.image.description", controlFile.Description);
      tr.annotations.set("org.opencontainers.image.version", controlFile.Version);
      tr.annotations.set("org.sirherobrine23.aptstream.control", JSON.stringify(controlFile));
      tr.annotations.set("com.github.package.type", "aptstream_package");
      await streamPromise.finished(createReadStream(filePath).pipe(tr.addEntry({
        name: filename,
        type: "file",
        size: (await fs.lstat(filePath)).size
      })));
      const img_info = await tr.finalize(options.tag||controlFile.Version);
      console.log("Image digest: %O", img_info.digest);
    }
  }
  await config.saveConfig().catch(() => {});
})

// APT Server
.command(["server", "serve", "s"], "Run http Server", yargs => yargs.option("config", {
  string: true,
  alias: "c",
  type: "string",
  description: "Config file path",
  default: "aptStream.yml"
}).option("port", {
  number: true,
  alias: "p",
  type: "number",
  description: "Alternative port to Run http server"
}).option("cluster", {
  number: true,
  type: "number",
  description: "Enable cluster mode for perfomace",
  alias: "t"
}).option("data", {
  string: true,
  alias: "C",
  type: "string",
  description: "data files"
}).option("db", {
  string: true,
  type: "string",
  alias: "d",
  description: "database url"
}).option("auto-sync", {
  type: "boolean",
  boolean: true,
  alias: "z",
  default: false,
  description: "Enable backgroud sync packages"
}).option("disable-release-compress", {
  type: "boolean",
  boolean: true,
  default: false,
  description: "Disable Release generate Packages.gz and Packages.gz to calculate hash",
  alias: "L"
}), async options => {
  const packageManeger = await packages(options.config);
  if (!!options.data) packageManeger.setDataStorage(options.data);
  if (!!options.port) packageManeger.setPortListen(options.port);
  if (!!options.db) packageManeger.setDatabse(options.db);
  if (!!options["disable-release-compress"]) packageManeger.setRelease("gzip", false).setRelease("xz", false);
  if (!!options.cluster && options.cluster > 0) packageManeger.setClusterForks(options.cluster);
  let forks = packageManeger.getClusterForks();
  if (cluster.isPrimary) {
    if (!!(options.autoSync ?? options["auto-sync"])) (async () => {
      while (true) {
        console.info("Initing package sync!");
        await packageManeger.syncRepositorys((_err, db) => {
          if (!db) return;
          const {repositoryID, controlFile: { Package, Architecture, Version }} = db;
          console.log("Sync/Add: %s -> %s %s/%s (%s)", repositoryID, Package, Architecture, Version)
        });
        console.log("Next sync after 30 Minutes");
        await new Promise(done => setTimeout(done, 1800000));
      }
    })().catch(err => {
      console.info("Auto sync packages disabled!");
      console.error(err);
    });
    if (forks > 0) {
      const forkProcess = async (count = 0): Promise<number> => new Promise((done, reject) => {
        const fk = cluster.fork();
        return fk.on("error", err => {
          console.error(err);
          return reject(err);
        }).on("online", () => done(fk.id)).once("exit", (code, signal) => {
          count++;
          if (!signal && code === 0) return console.info("Cluster %s: exited and not restarting", fk.id);
          else if (count > 5) return console.warn("Cluster get max count retrys!");
          console.info("Cluster %s: Catch %O, and restating with this is restating count %f", fk.id, code||signal, count);
          return forkProcess(count);
        });
      });
      for (let i = 0; i < forks; i++) await forkProcess().then(id => console.info("Cluster %s is online", id));
      return
    }
  }

  // Serve
  const app = express();
  app.disable("x-powered-by").disable("etag");
  app.use(express.json(), (_req, res, next) => {
    res.setHeader("cluster-id", String(cluster.isPrimary ? 1 : cluster.worker.id));
    res.json = (body) => res.setHeader("Content-Type", "application/json").send(JSON.stringify(body, null, 2)); return next();
  });

  // Serve info
  app.get("/", async ({res}) => {
    return res.json({
      cluster: cluster.worker?.id ?? 1,
      sourcesCount: packageManeger.getRepositorys().length,
      packagesRegistred: await packageManeger.packagesCount(),
      db: packageManeger.getClientInfo(),
    });
  });

  // Public key
  app.get("/public(_key|)(|.gpg|.dearmor)", async (req, res) => res.setHeader("Content-Type", req.path.endsWith(".dearmor") ? "octect/stream" : "text/plain").send(await packageManeger.getPublicKey(req.path.endsWith(".dearmor") ? "dearmor" : "armor")));

  // Get dists
  app.get("/dists", async ({res}) => res.json(Array.from(new Set(packageManeger.getRepositorys().map(d => d.repositoryName)))));
  app.get("/dists/:distName/info", async (req, res) => res.json(await packageManeger.repoInfo(req.params.distName)));
  app.get("/dists/(:distName)(|/InRelease|/Release(.gpg)?)?", async (req, res) => {
    const lowerPath = req.path.toLowerCase(), aptRoot = path.posix.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../..");
    let Release = await packageManeger.createRelease(req.params["distName"], aptRoot);
    let releaseText: string;
    if (lowerPath.endsWith("inrelease")||lowerPath.endsWith("release.gpg")) releaseText = await Release.inRelease(req.path.endsWith(".gpg") ? "clearMessage" : "sign");
    else if (lowerPath.endsWith("release")) releaseText = Release.toString();
    else return res.json(Release.toJSON());
    return res.status(200).setHeader("Content-Type", "text/plain").setHeader("Content-Length", String(Buffer.byteLength(releaseText))).send(releaseText);
  });

  app.get("/dists/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?", async (req, res) => {
    const { distName, componentName, Arch } = req.params;
    const reqPath = req.path;
    return packageManeger.createPackage(distName, componentName, Arch, path.posix.resolve("/", path.posix.join(req.baseUrl, req.path), "../../../../../.."), {
      compress: reqPath.endsWith(".gz") ? "gz" : reqPath.endsWith(".xz") ? "xz" : undefined,
      callback: (str) => str.pipe(res.writeHead(200, {}))
    });
  });

  // Send package hashs
  app.get("/pool", async ({res}) => res.json(await packageManeger.getPackagesHash()));

  app.get("/pool/(:hash)(|/data.tar|.deb)", async (req, res) => {
    const packageID = (await packageManeger.pkgQuery({"controlFile.MD5sum": req.params.hash})).at(0);
    if (!packageID) return res.status(404).json({error: "Package not exist"});
    if (req.path.endsWith("/data.tar")||req.path.endsWith(".deb")) {
      const str = await packageManeger.getPackageStream(packageID);
      if (req.path.endsWith(".deb")) return str.pipe(res.writeHead(200, {}));
      return (await Debian.getPackageData(str)).pipe(res.writeHead(200, {}));
    }
    return res.json({...packageID.controlFile, Filename: undefined});
  });

  // Upload file
  const uploadIDs = new Map<string, {createAt: Date, deleteAt: Date, uploading: boolean, repositoryID: string, filename: string}>();
  const uploadRoute = express.Router();
  app.use("/upload", uploadRoute);
  uploadRoute.get("/", ({res}) => res.json({available: true}));
  uploadRoute.use(expressRate({
    skipSuccessfulRequests: true,
    windowMs: 1000 * 60 * 40,
    max: 1000,
  })).post("/", async ({body, headers: { authorization }}, res) => {
    if (!authorization) return res.status(401).json({error: "Require authorization/Authorization header"});
    else if (!(authorization.startsWith("Bearer "))) return res.status(401).json({error: "Invalid authorization schema"});
    else if (!(await packageManeger.userAs(authorization.replace("Bearer", "").trim()))) return res.status(401).json({error: "Invalid token!"});

    if (!body) return res.status(400).json({error: "Required JSON or YAML to set up upload"});
    const { repositoryID, control } = body as {repositoryID: string, control: Debian.debianControl};
    if (!repositoryID) return res.status(400).json({error: "Required repository ID"});
    if (!control) return res.status(400).json({error: "Required debian control JSON"});
    const repo = packageManeger.getRepository(repositoryID).get(repositoryID);
    if (!repo.enableUpload) return res.status(401).json({message: "This repository not support upload or not setup to Upload files!"});
    let reqID: string;
    while (true) if (!(uploadIDs.has(reqID = crypto.randomBytes(12).toString("hex")))) break;
    const { Package: packageName, Architecture, Version } = control;
    const createAt = new Date(), deleteAt = new Date(createAt.getTime() + (1000 * 60 * 5));
    setTimeout(() => {if (uploadIDs.has(reqID)) uploadIDs.delete(reqID);}, createAt.getTime() - deleteAt.getTime())
    uploadIDs.set(reqID, {
      createAt, deleteAt,
      repositoryID,
      uploading: false,
      filename: `${packageName}_${Architecture}_${Version}.deb`,
    });
    return res.status(201).json({
      repositoryType: repo.type,
      uploadID: reqID,
      config: uploadIDs.get(reqID),
    });
  }).put("/:uploadID", async (req, res) => {
    if (!(uploadIDs.has(req.params.uploadID))) return res.status(401).json({error: "Create uploadID fist!"});
    if (uploadIDs.get(req.params.uploadID).uploading) return res.status(401).json({error: "Create new uploadID, this in use"});
    else if (!(req.headers["content-type"].includes("application/octet-stream"))) return res.status(400).json({error: "Send octet stream file"});
    else if (!(req.headers["content-length"])) return res.status(422).json({error: "Required file size"});
    else if (Number(req.headers["content-length"]) < 10) return res.status(422).json({error: "The file too small!"});
    uploadIDs.get(req.params.uploadID).uploading = true;
    let { repositoryID, filename } = uploadIDs.get(req.params.uploadID);

    try {
      const up = await packageManeger.getRepository(repositoryID).uploadFile(repositoryID);
      const tagName = (Array.isArray(req.query.tagName) ? req.query.tagName.at(0).toString() : req.query.tagName.toString());
      if (up.githubUpload) {
        if (!tagName) res.setHeader("warning", "Using latest github release tag!");
        await streamPromise.finished(req.pipe(await up.githubUpload(filename, Number(req.headers["content-length"]), tagName)));
        return res.status(201).json({
          type: "Github release"
        });
      } else if (up.gdriveUpload) {
        const id = (Array.isArray(req.query.id) ? req.query.id.at(0).toString() : req.query.id.toString());
        await streamPromise.finished(req.pipe(await up.gdriveUpload(filename, id)));
        return res.status(201).json({
          type: "Google driver"
        });
      } else if (up.ociUpload) {
        if (typeof req.query.path === "string") filename = path.posix.resolve("/", req.query.path, filename);
        await streamPromise.finished(req.pipe(await up.ociUpload(filename)));
        return res.status(201).json({
          type: "Oracle cloud bucket",
          filename
        });
      } else if (up.dockerUpload) {
        const tar = await up.dockerUpload({
          os: "linux",
          architecture: req.query.arch||"generic" as any,
        });
        await streamPromise.finished(req.pipe(tar.addEntry({name: filename, size: Number(req.headers["content-length"])})));
        return res.status(201).json({
          type: "Oracle cloud bucket",
          image: await tar.finalize(tagName),
        });
      }
      return res.status(502).json({
        message: "Sorry, our error was caught"
      });
    } finally {
      uploadIDs.delete(req.params.uploadID);
    }
  });

  app.all("*", ({res}) => res.status(404).json({message: "Page not exists"}));
  app.use((err, _req, res, _next) => {
    console.error(err);
    return res.status(400).json({error: err?.message || String(err)});
  }).listen(packageManeger.getPortListen(), function () {
    const address = this.address();
    console.log("Port Listen on %O", typeof address === "object" ? address.port : address);
  });
}).parseAsync().catch(err => {
  console.error(err);
  process.exit(-1);
});