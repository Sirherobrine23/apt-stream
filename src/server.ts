import { extendsFS } from "@sirherobrine23/extends";
import express from "express";
import cluster from "node:cluster";
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import stream from "node:stream";
import { finished } from "node:stream/promises";
import { parse } from "node:url";
import { Connection } from "./config.js";
import "./patchExpress.js";
import { http } from "@sirherobrine23/http";
import { googleDriver, oracleBucket } from "@sirherobrine23/cloud";

const Range = (max: number) => {
  if (max < 0 || isNaN(max)) return new stream.PassThrough();
  return new stream.Transform({
    write(chunk, encoding, callback) {
      if (!(Buffer.isBuffer(chunk))) chunk = Buffer.from(chunk, encoding);
      this.push(chunk.subarray(Math.max(0, max)));
      max += Buffer.byteLength(chunk);
      if (0 <= max) this.push(null);
      callback();
    },
  });
}

export async function createRoute(configManeger: Connection) {
  const app = express();
  app.disable("x-powered-by").disable("etag");
  app.use(express.json(), (_req, res, next) => {
    res.setHeader("cluster-id", String(cluster.isPrimary ? 1 : cluster.worker.id));
    res.json = (body) => res.setHeader("Content-Type", "application/json").send(JSON.stringify(body, null, 2)); return next();
  });

  // Public key
  app.get("/public(_key|)(|.gpg|.dearmor)", async (req, res) => {
    if (!configManeger.repoConfig.publicGPG) return res.status(400).json({ error: "GPG Key is disabled" });
    return res.setHeader("Content-Type", req.path.endsWith(".dearmor") ? "octect/stream" : "text/plain").send(await configManeger.repoConfig.getPulicKey(req.path.endsWith(".dearmor") ? "dearmor" : "armor"));
  });

  app.get("/dists/(:distName)(|/InRelease|/Release(.gpg)?)?", (req, res) => {
    const { distName } = req.params;
    if (!(configManeger.repoConfig.has(distName))) return res.status(404).json({ error: "Ditribuition not exist" });

    return res.json({ distName });
  });

  app.get("/dists/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?", (req, res) => {
    const { distName, componentName, Arch } = req.params;
    const compression = req.path.endsWith(".gz") ? "gzip" : req.path.endsWith(".xz") ? "lzma" : "none";
    if (!(configManeger.repoConfig.has(distName))) return res.status(404).json({ error: "Ditribuition not exist" });
    const sources = configManeger.repoConfig.get(distName).toArray().filter(info => info.componentName === componentName);
    if (!sources.length) return res.status(404).json({ error: "This component not exists" });

    return res.json({
      distName,
      componentName,
      Arch,
      compression
    });
  });

  app.post("/pool/upload", async (req, res) => {
    const { repository, destID } = (req.body || {});
    if (!(configManeger.repoConfig.has(repository))) return res.status(400).json({ error: "Add valid repository name" });
    else if (!(configManeger.repoConfig.get(repository).has(destID))) return res.status(400).json({ error: "Add valid source id" });
    else if (!(configManeger.repoConfig.get(repository).get(destID).enableUpload)) return res.status(401).json({ error: "the source has upload disabled or not supported" });

    const ID = crypto.randomUUID(), token = ([
      crypto.randomBytes(4).toString("hex"),
      crypto.randomBytes(crypto.randomInt(4, 16)).toString("hex"),
      crypto.randomBytes(crypto.randomInt(2, 8)).toString("hex"),
    ]).join("-");
    let filePath: string;
    while (true) {
      filePath = path.join(configManeger.repoConfig.tmpFolder, crypto.randomBytes(crypto.randomInt(8, 16)).toString("hex"));
      if (!(await extendsFS.exists(filePath))) break;
    }
    await fs.writeFile(filePath, ""); // Touch file

    await configManeger.uploadCollection.insertOne({
      ID,
      repository,
      destID,
      validAt: Date.now() + 1000 * 60 * 60 * 30,
      token,
      filePath,
    });

    return res.setHeader("Location", path.posix.join(parse(req.url).pathname, ID)).status(201).json({
      token,
      ID
    });
  });

  /**
   * PUT data to file to package to later upload to Dest
   *
   * to add data Set `Content-Range` and `Content-Type: application/octet-stream` to Upload
   * to submit, delete this headers up
   */
  app.put("/pool/upload/:sessionID", async (req, res) => {
    const { sessionID } = req.params;
    const info = await configManeger.uploadCollection.findOne({ ID: sessionID });
    const isPut = (req.headers["content-type"]||"").startsWith("application/octet-stream");
    if (!info) return res.status(400).json({ error: "Require upload ID" });
    else if (req.headers.authorization.slice(5).trim() !== info.token) return res.status(400).json({ error: "invalid token" });
    else if (isPut && !(req.headers["content-range"])) return res.status(400).json({ error: "set Content-Range to put file" });

    if (isPut) {
      if (req.headers["content-range"].startsWith("bytes ")) req.headers["content-range"] = req.headers["content-range"].slice(5).trim();
      if (req.headers["content-range"].trim() === "*") req.headers["content-range"] = "0";

      const [start, _end] = req.headers["content-range"].split("-"), [end] = _end.split("/");
      if (Number(end) < Number(start)) return res.status(400).json({ error: "Require file more that " + start })
      await finished(req.pipe(Range(Number(end || -1))).pipe(createWriteStream(info.filePath, { start: Number(start) })));
      await configManeger.uploadCollection.findOneAndUpdate({ ID: sessionID }, { $set: { validAt: 1000 * 60 * 60 * 30 } })
      return res.status(202).end();
    }

    const upload = await configManeger.repoConfig.get(info.repository).uploadFile(info.destID, info.filePath);
    await fs.rm(info.filePath, { force: true });
    await configManeger.uploadCollection.findOneAndDelete({ ID: info.ID });
    return res.setHeader("Location", `/pool/${upload.controlFile.MD5sum}.deb`).status(201).end();
  });

  app.get("/pool/(:packageHASH)(|.deb)?", async (req, res, next) => {
    const download = req.path.endsWith(".deb"), { packageHASH } = req.params;
    const info = await configManeger.packageCollection.findOne({ $or: [{ "control.MD5sum": packageHASH }, { "control.SHA1": packageHASH }, { "control.SHA256": packageHASH }, { "control.SHA512": packageHASH }] });
    if (!info) return res.status(404).json({ error: "Package not registred" });
    else if (!download) return res.json(info.control);
    const origem = info.repositorys.find(info => configManeger.repoConfig.has(info.repository) && configManeger.repoConfig.get(info.repository).has(info.origim));
    if (!origem) return res.status(400).json({ error: "Cannot get origem source" });
    const src = configManeger.repoConfig.get(origem.repository).get(origem.origim);
    if (src.type === "http") {
      return http.streamRequest(src.url, {
        query: src.query,
        headers: src.header
      }).then(src => src.pipe(res)).catch(next);
    } else if (src.type === "github") {
      const download: { url: string } = info.restoreFile;
      return http.streamRequest(download.url, {
        headers: src.token ? { Authorization: `token ${src.token}` } : {},
        query: { token: src.token },
      }).then(src => src.pipe(res)).catch(next);
    } else if (src.type === "mirror") {
      const download: { url: string } = info.restoreFile;
      return http.streamRequest(download.url).then(src => src.pipe(res)).catch(next);
    } else if (src.type === "oracleBucket") {
      const download: { filePath: string } = info.restoreFile;
      const oci = await oracleBucket.oracleBucket(src.authConfig);
      return oci.getFileStream(download.filePath).then(src => src.pipe(res)).catch(next);
    } else if (src.type === "googleDriver") {
      const download: { id: string } = info.restoreFile;
      const gdrive = await googleDriver.GoogleDriver({ oauth: await googleDriver.createAuth({ clientID: src.clientId, clientSecret: src.clientSecret, token: src.clientToken, authUrlCallback: () => { throw new Error("Auth disabled"); }, tokenCallback: () => { }, redirectURL: null }) });
      return gdrive.getFileStream(download.id).then(src => src.pipe(res)).catch(next);
    } else if (src.type === "docker") {
      throw new Error("CLOSE");
    } else return res.status(404).json({ error: "Source origem is unknown" });
  });
  return app;
}