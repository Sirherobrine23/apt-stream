#!/usr/bin/env node
import yargs from "yargs";
import { createAPI } from "./aptRepo/index.js";
yargs(process.argv.slice(2)).wrap(null).strict().help().option("cofig-path", {
  type: "string",
  default: process.cwd()+"/repoconfig.yml",
}).option("port", {
  type: "number",
  default: 3000,
}).parseAsync().then(options => {
  return createAPI({
    configPath: options["cofig-path"],
    portListen: options.port,
  });
});