#!/usr/bin/env node
import { Config, Connect, Source, generateGPG } from "./config.js";
import { createRoute } from "./server.js";
// import yargs from "yargs";
// const terminalSize = typeof process.stdout.getWindowSize === "function" ? process.stdout.getWindowSize()[0] : null;
// yargs(process.argv.slice(2)).wrap(terminalSize).version(false).help(true).alias("h", "help").strictOptions();

const initialConfig = new Config();
const gpg = await generateGPG();
initialConfig.publicGPG = gpg.publicKey;
initialConfig.privateGPG = gpg.privateKey;
initialConfig.set("google", new Source());

const db = await Connect(initialConfig);
const app = await createRoute(db);

app.listen(3000, () => console.log("Listen on 3000"));