#!/usr/bin/env node
import "./log.js";
import { connect } from "./database.js";
import { config, convertString } from "./config.js";
import packageManeger from "./configManeger.js";
import express from "express";
import yargs from "yargs";
import cluster from "node:cluster";
import apt from "./aptServer.js";
import openpgp from "openpgp";

yargs(process.argv.slice(2)).version(false).help(true).strictCommands().demandCommand().alias("h", "help").command("server", "Run http Server", yargs => yargs.option("config", {
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
    alias: "d"
  }).option("cache", {
    string: true,
    alias: "C",
    type: "string",
    description: "cache files"
  }), async options => {
  const appConfig = await config(options.config, {serverConfig: {portListen: options.port, clusterCount: options.cluster, cacheFolder: options.cache}});
  if ((appConfig.serverConfig?.clusterCount || 0) > 0 && cluster.isPrimary) {
    const ct = () => {
      const c = cluster.fork().on("error", err => console.error(err)).once("online", () => console.log("%s is online", c.id)).once("exit", (code, signal) => {
        if (code !== 0 && !signal) {
          console.log("Cluster %s restating", c.id);
          ct();
        }
        console.log("Cluster stoped with %O code, %O", code, signal);
      });
    }
    for (let i = 0; i < appConfig.serverConfig.clusterCount; i++) ct();
    return console.log("Clustered");
  }
  const db = await connect(appConfig);
  const app = express();
  app.get("/", ({res}) => res.json({cluster: cluster.isWorker, id: cluster.worker?.id}));
  app.get("/public(_key|)(|.gpg)", async ({res}) => {
    if (!appConfig.gpgSign) return res.status(404).json({error: "Gpg not configured"});
    const pubKey = (await openpgp.readKey({ armoredKey: appConfig.gpgSign.public.content })).armor();
    return res.setHeader("Content-Type", "application/pgp-keys").send(pubKey);
  });
  const aptRoute = apt(db, appConfig);
  app.use(aptRoute);
  app.listen(appConfig.serverConfig?.portListen ?? 0, function () {
    const address = this.address();
    console.log("Port Listen on %O", typeof address === "object" ? address.port : address);
  });
}).command(["maneger", "m", "$0"], "maneger packages in database", yargs => {
  return yargs.option("config", {
    string: true,
    alias: "c",
    type: "string",
    description: "Config file path",
    default: "aptStream.yml",
  }).command(["$0"], "Maneger config", yargs => yargs, options => packageManeger(options.config)).command(["print", "p"], "Print config to target default is json", yargs => yargs.option("outputType", {
    alias: "o",
    choices: ["yaml", "yml", "json", "json64", "yaml64", "yml64"],
    description: "target output file, targets ended with '64' is base64 string",
    default: "json"
  }), async (options) => console.log(await convertString(await config(options.config), options.outputType as any)));
}).parseAsync();