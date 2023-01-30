#!/usr/bin/env node
import "./log.js";
import { aptSConfig, configManeger, saveConfig } from "./configManeger.js";
import packagesStorage from "./packageStorage.js";
import createConfig from "./createConfig.js";
import coreUtils from "@sirherobrine23/coreutils";
import aptRoute from "./aptRoute.js";
import cluster from "node:cluster";
import express from "express";
import https from "node:https";
import yargs from "yargs";
import os from "node:os";
import path from "node:path";
process.title = "aptStream";

yargs(process.argv.slice(2)).version(false).help(true).alias("h", "help").demandCommand().strictCommands().command("server", "Start server", async yargs => {
  const options = yargs.strictOptions().option("port", {
    alias: "p",
    type: "number",
    default: 8080,
    description: "Port to listen on"
  }).option("cluster", {
    alias: "c",
    type: "number",
    default: 1,
    description: "Number of cluster workers"
  }).option("config", {
    alias: "C",
    type: "string",
    default: "aptStream.yaml",
    description: "Config file"
  }).parseSync();

  const config = await configManeger(options.config);
  const clusterSpawn = Number(config?.server?.cluster ?? options.cluster);
  if (clusterSpawn > 1) {
    if (cluster.isPrimary) {
      console.log("Main cluster maneger, PID %d started", process.pid);
      cluster.on("error", err => {
        console.log(err?.stack ?? String(err));
        // process.exit(1);
      }).on("exit", (worker, code, signal: NodeJS.Signals) => {
        // if (process[Symbol.for("ts-node.register.instance")]) cluster.setupPrimary({/* Fix for ts-node */ execArgv: ["--loader", "ts-node/esm"]});
        if (signal === "SIGKILL") return console.log("Worker %d was killed", worker?.id ?? "No ID");
        else if (signal === "SIGABRT") return console.log("Worker %d was aborted", worker?.id ?? "No ID");
        else if (signal === "SIGTERM") return console.log("Worker %d was terminated", worker?.id ?? "No ID");
        console.log("Worker %d died with code: %s, Signal: %s", worker?.id ?? "No ID", code, signal ?? "No Signal");
        cluster.fork();
      });
      for (let i = 0; i < clusterSpawn; i++) {
        console.log("Forking worker %d", i);
        cluster.fork().on("message", (msg) => console.log("Worker %d sent message: %o", i, msg));
      }
      return;
    }
    const id = cluster.worker?.id ?? "No ID", { pid } = process;
    console.log("Worker %d started, Node PID %f", id, pid);
  }

  // Process catch rejects
  process.on("unhandledRejection", err => console.error("Rejections Err: %s", err));
  process.on("uncaughtException", err => console.error("Uncaught Err: %s", err));


  let connectionCount = 0;
  const app = express();
  app.disable("x-powered-by").disable("etag").use(express.json()).use(express.urlencoded({ extended: true })).use((req, res, next) => {
    let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    if (Array.isArray(ip)) ip = ip[0];
    if (ip.slice(0, 7) === "::ffff:") ip = ip.slice(7);
    res.setHeader("Access-Control-Allow-Origin", "*").setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE").setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.json = (body) => {
      res.setHeader("Content-Type", "application/json");
      Promise.resolve(body).then((data) => res.send(JSON.stringify(data, (_, value) => {
        if (typeof value === "bigint") return value.toString();
        return value;
      }, 2)));
      return res;
    }

    const baseMessage = "Method: %s, IP: %s, Path: %s";
    const reqDate = new Date();
    const { method, path: pathLocal } = req;
    console.info(baseMessage, method, ip, pathLocal);
    res.once("close", () => {
      connectionCount--;
      const endReqDate = new Date();
      return console.info(`${baseMessage}, Code: %f, Response seconds: %f, `, method, ip, pathLocal, res.statusCode ?? null, endReqDate.getTime() - reqDate.getTime());
    });
    connectionCount++;
    next();
  });

  // Packages storage
  const packagesFunctions = await packagesStorage(config);

  // Host info
  app.get("/", async ({res}) => {
    const clusterID = cluster.isPrimary ? "Primary" : `Worker ${cluster.worker?.id ?? "No ID"}`;
    res.json({
      cpuCores: String(os.cpus().length || "Unknown"),
      system: process.platform || "Unknown",
      arch: String(os.arch() || "Unknown"),
      nodeVersion: process.version || "Unknown",
      database: config.db?.type || "Internal storage",
      connectionCount,
      clusterInfo: {
        isCluster: cluster.isWorker,
        clusterID,
      }
    });
  });

  // apt route
  const debianRoute = await aptRoute(config, packagesFunctions);
  app.use("/apt", debianRoute).use("/debian", debianRoute).use("/", debianRoute);

  // Start server
  const httpPort = Number(process.env.PORT ?? config?.server?.portListen ?? options.port);
  app.listen(httpPort, function() {const address = this.address() as any; console.log("Server listening on port %d", address?.port ?? "No Port");});

  // Https server
  if (config?.server?.httpsPortListen) {
    const httpsConfig = config.server.httpsPortListen;
    const httpsPort = Number(httpsConfig.port);
    console.log(httpsPort, httpsConfig);
    https.createServer({
      key: httpsConfig.key,
      cert: httpsConfig.cert,
    }, app).listen(httpsPort, function() {const address = this.address() as any; console.log("Https server listening on port %d", address?.port ?? "No Port");});
  }
}).command("maneger", "Maneger packages and config", async yargs => {
  const options = yargs.strictOptions().option("config", {
    alias: "C",
    type: "string",
    default: "aptStream.yaml",
    description: "Config file"
  }).option("newConfig", {
    alias: "N",
    type: "boolean",
    default: false,
    description: "Create new config file"
  }).parseSync();
  let config: Partial<aptSConfig>;
  if (options.newConfig||!await coreUtils.extendsFS.exists(options.config)) config = await createConfig.createConfig(path.resolve(path.dirname(options.config)));
  else config = await configManeger(options.config);
  config = await createConfig.manegerRepositorys(config);
  return saveConfig(config, options.config);
}).parseAsync();