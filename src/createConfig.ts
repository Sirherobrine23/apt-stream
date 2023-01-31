import { aptSConfig, repositoryFrom } from "./configManeger.js";
import { Cloud, http } from "@sirherobrine23/coreutils";
import { extendsFS } from "@sirherobrine23/coreutils/src/packages/extends/src/index.js";
import { readFile } from "node:fs/promises";
import { format } from "node:util";
import acmeClient from "acme-client";
import inquirer from "inquirer";
import openpgp from "openpgp";
import express from "express";
import path from "node:path";
import ora from "ora";
import os from "node:os";

export default {createConfig, manegerRepositorys};

export async function createHTTPScertificate(email: string, domains: string[]) {
  const client = new acmeClient.Client({
    accountKey: await acmeClient.crypto.createPrivateKey(),
    directoryUrl: acmeClient.directory.letsencrypt.production,
  });

  await client.createAccount({
    termsOfServiceAgreed: true,
    contact: [`mailto:${email}`]
  });

  const [key, csr] = await acmeClient.crypto.createCsr({
    commonName: domains[0],
    altNames: domains.slice(1)
  });
  let close: () => void;
  const cert = await client.auto({
    termsOfServiceAgreed: true,
    email: `mailto:${email}`,
    challengePriority: ["dns-01"],
    csr,
    async challengeCreateFn(authz, challenge, keyAuthorization) {
      if (challenge.type === "dns-01") {
        const dnsRecord = `_acme-challenge.${authz.identifier.value}`;
        console.log("Would create TXT record %O with value %O", dnsRecord, keyAuthorization);
        return;
      }
      const { ipv4, ipv6 } = await http.getExternalIP();
      if (ipv6) console.log("Add AAA (%O) Record for %O", authz.identifier.value, ipv6);
      if (ipv4) console.log("Add A (%O) Record for %O", authz.identifier.value, ipv4);
      const app = express();
      app.use((req, _2, next) => {
        next();
        console.log(req.path);
      })
      app.get("/.well-known/acme-challenge/*", (req, res) => {
        res.send(keyAuthorization);
      });
      const server = app.listen(80, () => {
        console.log(`Listening on port 80`);
      });
      close = () => server.close();
    },
    async challengeRemoveFn(authz, challenge, keyAuthorization) {
      if (close) {
        console.log("Closing server");
        close();
      } else {
        const dnsRecord = `_acme-challenge.${authz.identifier.value}`;
        console.log("Would remove TXT record %O with value %O", dnsRecord, keyAuthorization);
      }
    },
  });

  return {
    csr: csr.toString(),
    key: key.toString(),
    cert: cert.toString()
  };
}

export async function createConfig(configDir: string) {
  console.log("Welcome to apt-stream, this is setup wizard, please answer the following questions");
  const partialConfig: Partial<aptSConfig> = {};
  const basicInput = await inquirer.prompt<{portListen: number|string, https: boolean, cluster: number|string, pgpGen: boolean, useDB: boolean}>([
    {
      type: "input",
      name: "portListen",
      message: "HTTP Port to listen",
      default: 3000
    },
    {
      type: "confirm",
      name: "https",
      message: "User HTTPs?",
      default: false
    },
    {
      type: "input",
      name: "cluster",
      message: "Number to user in cluster mode, defaults to half of the number of CPUs, to disable set to negative numbers",
      default: os.cpus().length,
      validate(input) {
        if (isNaN(Number(input))) return "Please enter a number";
        return true;
      }
    },
    {
      type: "confirm",
      name: "pgpGen",
      message: "Generate PGP key?",
      default: true
    },
    {
      type: "confirm",
      name: "useDB",
      message: "Use database",
      default: true
    }
  ]);

  // Server config
  partialConfig.server ??= {};
  partialConfig.server.cluster = Number(basicInput.cluster) > 0 ? Number(basicInput.cluster) : 0;
  partialConfig.server.portListen = Number(basicInput.portListen);

  // Connect to database
  if (basicInput.useDB) {
    const { dbType } = await inquirer.prompt<{ dbType: aptSConfig["db"]["type"] }>({
      type: "list",
      name: "dbType",
      message: "Database type",
      choices: [
        {
          name: "MongoDB",
          value: "mongodb",
          checked: true
        },
        {
          name: "CouchDB",
          value: "couchdb"
        }
      ],
    });
    if (dbType === "mongodb") {
      const mongoInfo = await inquirer.prompt<{url: string, dbName: string, collentionName: string}>([
        {
          type: "input",
          name: "url",
          message: "MongoDB URL",
          default: "mongodb://127.0.0.1:27017"
        },
        {
          type: "input",
          name: "dbName",
          message: "Database name",
          default: "apt-stream"
        },
        {
          type: "input",
          name: "collentionName",
          message: "Collention name",
          default: "packages"
        }
      ]);

      // Connection test
      const oraTest = ora("Testing connection").start();
      try {
        const { default: mongodb } = await import("mongodb");
        const client = new mongodb.MongoClient(mongoInfo.url);
        await (await client.connect()).close();
        partialConfig.db = {
          type: "mongodb",
          url: mongoInfo.url,
          db: mongoInfo.dbName,
          collection: mongoInfo.collentionName
        };
        oraTest.succeed("Connection successful");
      } catch (e) {
        oraTest.fail("Failed to connect to database");
        throw e;
      }
    } else if (dbType === "couchdb") {
      const couchInfo = await inquirer.prompt<{url: string, dbName: string}>([
        {
          type: "input",
          name: "url",
          message: "CouchDB URL",
          default: "http://127.0.0.1:5984"
        },
        {
          type: "input",
          name: "dbName",
          message: "Database name",
          default: "apt-stream"
        }
      ]);

      // Connection test
      const oraTest = ora("Testing connection").start();
      try {
        const { default: nano } = await import("nano");
        const client = nano(couchInfo.url);
        await client.db.create(couchInfo.dbName);
        partialConfig.db = {
          type: "couchdb",
          url: couchInfo.url,
          dbName: couchInfo.dbName
        };
        oraTest.succeed("Connection successful");
      } catch (e) {
        oraTest.fail("Failed to connect to database");
        throw e;
      }
    } else console.error("Unknown database type");
  }

  // PGP config
  if (basicInput.pgpGen) {
    const pgpInfo = await inquirer.prompt<{name: string, email: string, password: string}>([
      {
        type: "input",
        name: "name",
        message: "You name to use in PGP key",
        default: os.userInfo().username
      },
      {
        type: "input",
        name: "email",
        message: "You email to use in PGP key",
        default: `${os.userInfo().username}@${os.hostname()}`
      },
      {
        type: "password",
        name: "password",
        message: "Password to use in PGP key, leave blank for no password",
        default: "",
        mask: "*"
      }
    ]);
    const oraGen = ora("Generating PGP key").start();
    try {
      const keys = await openpgp.generateKey({
        format: "armored",
        type: "rsa",
        curve: "ed25519",
        rsaBits: 4096,
        passphrase: pgpInfo.password ? pgpInfo.password : undefined,
        userIDs: [
          {
            name: pgpInfo.name,
            email: pgpInfo.email
          }
        ]
      });
      oraGen.succeed("Generated PGP key");
      let privateKeySave: string;
      let publicKeySave: string;
      // write key to file
      if (await inquirer.prompt<{write: boolean}>({type: "confirm", name: "write", message: "Write key to file?", default: true}).then(a => a.write)) {
        const keyFilesName = await inquirer.prompt<{private: string, public: string}>([
          {
            type: "input",
            name: "private",
            message: "Private key file path",
            default: path.resolve(configDir, "pgpPrivate.key")
          },
          {
            type: "input",
            name: "public",
            message: "Public key file path",
            default: path.resolve(configDir, "pgpPublic.key")
          }
        ]);
        privateKeySave = keyFilesName.private;
        publicKeySave = keyFilesName.public;
      }
      partialConfig.server ??= {};
      partialConfig.server.pgp = {
        passphrase: pgpInfo.password ? pgpInfo.password : undefined,
        privateKeySave,
        privateKey: keys.privateKey,
        publicKeySave,
        publicKey: keys.publicKey,
      }
    } catch (e) {
      oraGen.fail("Failed to generate PGP key");
      throw e;
    }
  }

  // add repository main object
  partialConfig.repositorys = {};

  return partialConfig as aptSConfig;
}

async function createFrom(): Promise<repositoryFrom> {
  const repoType = await inquirer.prompt({
    type: "list",
    name: "repoType",
    message: "Repository type",
    choices: [
      {
        name: "Exit",
        value: "exit"
      },
      {
        name: "Mirror APT repository",
        value: "mirror"
      },
      {
        name: "Simples HTTP/HTTPs requests",
        value: "http"
      },
      {
        name: "GitHub",
        value: "github"
      },
      {
        name: "Google Driver",
        value: "google_driver"
      },
      {
        name: "Oracle Cloud Bucket",
        value: "oracle_bucket"
      }
    ]
  }).then(a => a.repoType as repositoryFrom["type"]|"exit");
  if (repoType === "exit") return null;
  else if (repoType === "http") {
    const httpInfo = await inquirer.prompt<{url: string, requiredAuth: boolean}>([
      {
        type: "input",
        name: "url",
        message: "URL to repo",
        validate(input) {
          try {
            new URL(input);
            return true;
          } catch (err) {
            return String(err);
          }
        }
      },
      {
        type: "confirm",
        name: "requiredAuth",
        message: "Request require auth?",
        default: false
      }
    ]);
    const repo: repositoryFrom = {
      type: "http",
      url: httpInfo.url
    };
    if (httpInfo.requiredAuth) {
      const httpAuth = JSON.parse(await inquirer.prompt({
        type: "editor",
        name: "auth",
        message: "Auth data",
        default: JSON.stringify({
          headers: {},
          query: {},
        }, null, 2)
      }).then(a => a.auth));
      repo.auth = {
        header: httpAuth.headers,
        query: httpAuth.query
      };
    }
    return repo;
  } else if (repoType === "github") {
    let { owner, repository, token, variant } = await inquirer.prompt<{owner: string, repository: string, token?: string, variant: "repo"|"release"}>([
      {
        type: "input",
        name: "owner",
        message: "Repository owner",
        validate(input) {
          if (input.length < 1) return "Owner can't be empty";
          if (input.length > 39) return "Owner can't be longer than 39 characters";
          if (input.includes("/")) return "Owner can't include /";
          return true;
        },
      },
      {
        type: "input",
        name: "repository",
        message: "Repository name",
        validate(input) {
          if (input.length < 1) return "Repository name can't be empty";
          if (input.length > 100) return "Repository name can't be longer than 100 characters";
          if (input.includes("/")) return "Repository name can't include /";
          return true;
        }
      },
      {
        type: "password",
        name: "token",
        message: "Token"
      },
      {
        type: "list",
        name: "variant",
        message: "Variant",
        default: "release",
        choices: [
          "release",
          "repo",
        ]
      },
    ]);
    if (!token?.trim()) token = undefined;
    const gh = await http.Github.GithubManeger(owner, repository, token);
    if (variant === "repo") {
      const remoteBranches = await gh.branchList().then(a => a.flat().map(b => b.name));
      const { branch } = await inquirer.prompt<{branch: string}>({
        type: "list",
        name: "branch",
        message: "Select branch",
        choices: remoteBranches,
        default: remoteBranches.at(0)
      });
      return {
        type: "github",
        subType: "branch",
        token,
        owner,
        repository,
        branch: branch ?? "master"
      };
    } else if (variant === "release") {
      const oraGetRelease = ora("Getting release tags").start();
      let releaseTags: {tagName: string, isPrerelease: boolean}[] = [];
      try {
        releaseTags = (await gh.getRelease()).map(rel => ({tagName: rel.tag_name, isPrerelease: rel.prerelease}));
        oraGetRelease.succeed("Got release tags");
      } catch (err) {
        oraGetRelease.fail(format("Failed to get release tags, err: %s", err));
        throw err;
      }
      let { tag } = await inquirer.prompt<{tag: string[]}>({
        type: "checkbox",
        name: "tag",
        message: "Select tags",
        choices: releaseTags.map((a, index) => ({
          checked: !a.isPrerelease && index < 4,
          name: `${a.isPrerelease ? "Prerelease" : "Release"} ${a.tagName}`,
          value: a.tagName
        })),
      });
      if (tag?.length < 0) tag = undefined;
      return {
        type: "github",
        subType: "release",
        token,
        owner,
        repository,
        tag
      };
    } else throw new Error("Unknown github variant");
  } else if (repoType === "google_driver") {
    const data = await inquirer.prompt<{appID: string, appSecret: string}>([]);
    let token: Cloud.googleCredential;
    const gdrive = await Cloud.GoogleDriver({
      clientID: data.appID,
      clientSecret: data.appSecret,
      callback(err, data) {
        if (err) throw err;
        else if (data.authUrl) console.log("Open this url in browser: %O", data.authUrl);
        else if (data.token) {
          console.log("Sucess google auth");
          token = data.token;
        }
      },
    });
    if (!token) throw new Error("Failed to auth google");
    const files = (await gdrive.listFiles()).filter(file => file.name.endsWith(".deb"));
    const { id = [] } = await inquirer.prompt<{id: string[]}>({
      type: "checkbox",
      name: "id",
      message: "Select files",
      choices: files.map(file => ({
        name: file.name,
        value: file.id
      }))
    });
    return {
      type: "google_driver",
      app: {
        id: data.appID,
        secret: data.appSecret,
        token
      },
      id,
    };
  } else if (repoType === "oracle_bucket") {
    const userConfig = await inquirer.prompt([
      {
        type: "input",
        name: "namespace",
        message: "Namespace",
      },
      {
        type: "input",
        name: "name",
        message: "Bucket name",
      },
      {
        type: "input",
        name: "tenancy",
        message: "Tenancy",
      },
      {
        type: "input",
        name: "user",
        message: "User",
      },
      {
        type: "input",
        name: "fingerprint",
        message: "Fingerprint",
      },
      {
        type: "input",
        name: "key",
        message: "Private Key path",
        async validate(input) {
          if (!input) return "Private key path can't be empty";
          else if (!await extendsFS.exists(input)) return "Private key path not exists";
          else if (!await extendsFS.isFile(path.resolve(process.cwd(), input))) return "Private key path is not a file";
          return true;
        },
      },
      {
        type: "password",
        name: "passphrase",
        message: "Passphrase",
        mask: "*"
      },
      {
        type: "list",
        name: "region",
        message: "Select region",
        choices: [
          "af-johannesburg-1",
          "ap-chuncheon-1",
          "ap-hyderabad-1",
          "ap-melbourne-1",
          "ap-mumbai-1",
          "ap-osaka-1",
          "ap-seoul-1",
          "ap-singapore-1",
          "ap-sydney-1",
          "ap-tokyo-1",
          "ca-montreal-1",
          "ca-toronto-1",
          "eu-amsterdam-1",
          "eu-frankfurt-1",
          "eu-madrid-1",
          "eu-marseille-1",
          "eu-milan-1",
          "eu-paris-1",
          "eu-stockholm-1",
          "eu-zurich-1",
          "il-jerusalem-1",
          "me-abudhabi-1",
          "me-jeddah-1",
          "mx-queretaro-1",
          "sa-santiago-1",
          "sa-saopaulo-1",
          "sa-vinhedo-1",
          "uk-cardiff-1",
          "uk-london-1",
          "us-ashburn-1",
          "us-chicago-1",
          "us-phoenix-1",
          "us-sanjose-1"
        ]
      }
    ]);

    const configAuth: Cloud.oracleOptions = {
      namespace: userConfig.namespace,
      name: userConfig.name,
      region: userConfig.region,
      auth: {
        type: "user",
        fingerprint: userConfig.fingerprint,
        user: userConfig.user,
        tenancy: userConfig.tenancy,
        passphase: userConfig.passphrase,
        privateKey: await readFile(path.resolve(process.cwd(), userConfig.key), "utf8")
      }
    };

    const files = (await (await Cloud.oracleBucket(configAuth)).listFiles()).filter(file => file.path.endsWith(".deb"));
    const { fileList = [] } = await inquirer.prompt<{fileList: string[]}>({
      type: "list",
      name: "fileList",
      message: "Select files",
      choices: files.map(file => ({
        checked: true,
        name: file.path,
        value: file.path
      }))
    });
    return {
      type: "oracle_bucket",
      authConfig: configAuth,
      path: fileList,
    }
  } else if (repoType === "mirror") {}

  throw new Error("Unknown repository type");
}

async function configRepository(base: aptSConfig["repositorys"][string]) {
  while(true) {
    if (!base.from.length) base.from = [await createFrom()];
    const { from } = await inquirer.prompt<{from: "add"|"exit"|number}>({
      type: "list",
      name: "from",
      message: "Select from",
      choices: [
        {
          name: "Exit",
          value: "exit"
        },
        {
          name: "Add from",
          value: "add"
        },
        ...(base.from.map((a, index) => {
          let name = `Delete: ${a.type}`;
          if (a.type === "github") name += `, ${a.owner}/${a.repository} ${a.subType}`;
          else if (a.type === "http") name += `, ${a.url}`;
          else if (a.type === "mirror") name += `, ${a.url} ${Object.keys(a.dists).join(", ")}`;
          return {name, value: index};
        })),
      ]
    });

    if (from === "exit") break;
    else if (from === "add") await createFrom().then(a => !!a ? base.from.push(a):null).catch(err => console.error(err));
    else base.from.splice(from, 1);
  }
  return base;
}

async function createRepository(base: aptSConfig["repositorys"]) {
  const repoName = await inquirer.prompt<{name: string}>({
    type: "input",
    name: "name",
    message: "Repository name",
    validate(input) {
      if (!input) return "Repository name can't be empty";
      if (input in base) return "Repository name already exists";
      if (encodeURIComponent(input) !== input) return "Repository name can't contain special characters";
      return true;
    }
  }).then(a => a.name);
  base[repoName] = {from: [], aptConfig: {}};
  base[repoName] = await configRepository(base[repoName]);
  return base;
}

export async function manegerRepositorys(serverConfig: aptSConfig|Partial<aptSConfig>) {
  while(true) {
    if (!Object.keys(serverConfig.repositorys).length) serverConfig.repositorys = await createRepository({});
    const { action } = await inquirer.prompt<{action: -1|-2|string}>({
      type: "list",
      name: "action",
      message: "What do you want to do?",
      choices: [
        {
          name: "Exit",
          value: -1
        },
        {
          name: "Create repository",
          value: -2
        },
        ...(Object.keys(serverConfig.repositorys).map(a => ({
          name: `Edit ${a}`,
          value: a
        })))
      ]
    });
    if (action === -1) return serverConfig;
    else if (action === -2) serverConfig.repositorys = await createRepository(serverConfig.repositorys);
    else serverConfig.repositorys[action] = await configRepository(serverConfig.repositorys[action]);
  }
  return serverConfig;
}
