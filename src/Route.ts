import cluster from "node:cluster";
import express from "express";
import configManeger from "./configManeger.js";

export default createRouters;
export async function createRouters(config: string) {
  const serverConfig = await configManeger(config);
  const app = express.Router();
  app.use(express.json()).use(express.urlencoded({ extended: true })).use((req, res, next) => {
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

    const clusterID = cluster.worker?.id ?? 0;
    const baseMessage = "[Date: %s, Cluster: %s]: Method: %s, IP: %s, Path: %s";
    const reqDate = new Date();
    const { method, path } = req;
    console.log(baseMessage, reqDate.toUTCString(), clusterID, method, ip, path);
    res.once("close", () => {
      const endReqDate = new Date();
      return console.log(`${baseMessage}, Code: %f, res seconds: %f, `, endReqDate.toUTCString(), clusterID, method, ip, path, res.statusCode ?? null, endReqDate.getTime() - reqDate.getTime());
    });
    next();
  });

  app.get("/", ({res}) => res.json({message: "Hello World!"}));

  // Return router and config
  return {
    app,
    serverConfig,
  };
}