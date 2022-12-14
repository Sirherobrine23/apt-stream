import express from "express";
import { format } from "node:util";
import * as utils from "./utils.js";

export function createAPI(rootRepo?: string) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({extended: true}));
  app.use((_req, res, next) => {
    res.json = (data) => res.setHeader("Content-Type", "application/json").send(JSON.stringify(data, null, 2));
    next();
  });

  // Packages avaibles
  app.get("/", (_req, res) => res.json({
    packages: []
  }));

  // source.list
  app.get("/sources.list", (req, res) => {
    res.setHeader("Content-type", "text/plain")
    res.send(format("deb %s://%s ./ main\n", req.protocol, req.headers.host));
  });

  // Pool
  app.get("/pool/:repo/:package_name", (req, res) => {});

  // dist
  app.get("/dist/:suite/Release", (req, res) => {
    const data = utils.mountRelease({
      Origin: "Test",
      Suite: req.params.suite,
      Components: ["main"],
      Architectures: ["amd64"]
    });
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Length", data.length);
    res.send(data);
  });
  // app.get("/dist/:suite/InRelease", (req, res) => {});
  app.get("/dist/:suite/:component/binary-:arch/Release", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.send(utils.mountRelease({
      Origin: "Test",
      Archive: req.params.suite,
      Components: ["main"],
      Architectures: ["amd64"]
    }));
  });
  app.get("/dist/:suite/:component/binary-:arch/Packages.gz", async (req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/x-gzip"
    });
    await utils.createPackagegz(res, []);
  });
  return app;
}
createAPI().listen(3000, () => console.log("Listen on 3000"));