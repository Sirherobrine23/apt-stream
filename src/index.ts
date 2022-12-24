#!/usr/bin/env node
import yargs from "yargs";
import repo from "./apt_repo_v2.js";
import openpgp from "openpgp";
import { getConfig, saveConfig } from "./repoConfig.js";

yargs(process.argv.slice(2)).wrap(null).strict().help().strictCommands().option("cofig-path", {
  type: "string",
  default: process.cwd()+"/repoconfig.yml",
}).command("config", "maneger basics configs", async yargs => {
  const options = yargs.option("generate-keys", {
    type: "boolean",
    default: false,
    alias: "g",
  }).option("passphrase", {
    type: "string",
    default: "",
    alias: "p",
  }).option("name", {
    type: "string",
    default: "",
    alias: "n",
  }).option("email", {
    type: "string",
    default: "",
    alias: "e",
  }).parseSync();

  const config = await getConfig(options.cofigPath);
  if (options.generateKeys) {
    if (!options.email) throw new Error("email is required");
    if (!options.name) throw new Error("name is required");
    if (!options.passphrase) options.passphrase = undefined;
    const keys = await openpgp.generateKey({
      type: "rsa",
      rsaBits: 4096,
      userIDs: [{ name: options.name, email: options.email }],
      passphrase: options.passphrase
    });
    if (!config["apt-config"]) config["apt-config"] = {};
    config["apt-config"].pgpKey = {
      private: keys.privateKey,
      public: keys.publicKey,
      passphrase: options.passphrase,
    }
  }
  await saveConfig(options.cofigPath, config);
}).command("server", "Run HTTP serber", yargs => {
  const options = yargs.parseSync();
  return repo(options.cofigPath);
}).parseAsync();