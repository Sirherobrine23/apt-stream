#!/usr/bin/env node
import "./log.js";
import { connect } from "./database.js";
import { config } from "./config.js";
import packageManeger from "./configManeger.js";
import express from "express";
import yargs from "yargs";
import cluster from "node:cluster";
import apt from "./aptServer.js";

yargs(process.argv.slice(2)).version(false).help(true).strictCommands().demandCommand().alias("h", "help").command("server", "Run http Server", async yargs => {
  const options = yargs.option("config", {
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
  }).parseSync();
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
  const aptRoute = apt(db, appConfig);
  app.use(aptRoute);
  app.listen(appConfig.serverConfig?.portListen ?? 0, function () {
    const address = this.address();
    console.log("Port Listen on %O", typeof address === "object" ? address.port : address);
  });
}).command("package", "maneger packages in database", yargs => {
  const { config } = yargs.option("config", {
    string: true,
    alias: "c",
    type: "string",
    description: "Config file path",
    default: "aptStream.yml"
  }).parseSync();
  return packageManeger(config);
}).parseAsync();