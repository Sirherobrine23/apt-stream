import * as dockerRegistry from "@sirherobrine23/docker-registry";
import { config, aptStreamConfig, save, repositorySource } from "./config.js";
import inquirer, { QuestionCollection } from "inquirer";
import { googleDriver, oracleBucket } from "@sirherobrine23/cloud";
import { syncRepository } from "./packageManege.js";
import { connect } from "./database.js";
import { Github } from "@sirherobrine23/http";
import openpgp from "openpgp";
import ora from "ora";
import path from "path";
import fs from "fs/promises";
import { extendsFS } from "@sirherobrine23/extends";

async function simpleQuestion<T = any>(promp: QuestionCollection): Promise<Awaited<T>> {
  promp["name"] ??= "No name";
  return (inquirer.prompt(promp)).then(d => d[Object.keys(d).at(-1)]);
}

async function createRepository(config: aptStreamConfig): Promise<aptStreamConfig> {
  const name = await simpleQuestion({message: "Repository name", type: "input"});
  if (config.repository[name]) {
    console.log("Repository are exists!");
    return createRepository(config);
  }
  config.repository[name] = {source: []};
  return manegerSource(config, name);
}

async function createSource(): Promise<repositorySource> {
  const target = await simpleQuestion<repositorySource["type"]>({
    type: "list",
    message: "Select target",
    choices: [
      {
        value: "http",
        name: "HTTP Directly"
      },
      {
        value: "github",
        name: "Github repository"
      },
      {
        value: "google_driver",
        name: "Google Driver"
      },
      {
        value: "oracle_bucket",
        name: "Oracle Cloud Bucket"
      },
      {
        value: "docker",
        name: "Docker or Open Container image (OCI) image"
      }
    ]
  });

  if (target === "http") {
    return {
      type: "http",
      url: await simpleQuestion<string>({
        message: "Package URL",
        type: "input",
        validate(input) {
          try {
            new URL(input);
            return true;
          } catch {
            return "enter valid url"
          }
        },
      }),
    };
  } else if (target === "google_driver") {
    const props = await inquirer.prompt([
      {
        name: "clientId",
        message: "oAuth Client ID",
        type: "input",
      },
      {
        name: "clientSecret",
        message: "oAuth Client Secret",
        type: "input"
      }
    ]);
    let token: googleDriver.googleCredential;
    const gdrive = await googleDriver.GoogleDriver({
      clientID: props.clientId,
      clientSecret: props.clientSecret,
      callback(err, data) {
        if (err) throw err;
        if (data.authUrl) return console.log("Open this link in browser: %O", data.authUrl);
        console.log("Auth success");
        token = data.token;
      },
    });
    let id: string[] = [];
    if (await simpleQuestion<boolean>({type: "confirm", message: "Select files?"})) {
      const wait = ora().start("Listening files...");
      const files = (await gdrive.listFiles().catch(err => {wait.fail(err?.message || String(err)); return Promise.reject(err);})).filter(f => f.name.endsWith(".deb"));
      wait.succeed();
      id = await simpleQuestion<string[]>({
        type: "checkbox",
        message: "Select files",
        choices: files.map(f => ({
          name: f.name,
          value: f.id,
        }))
      });
    }
    return {
      type: "google_driver",
      clientId: props.clientId,
      clientSecret: props.clientSecret,
      clientToken: token,
      gIds: id
    };
  } else if (target === "oracle_bucket") {
    const { namespace, name, region, authType } = await inquirer.prompt<{namespace: string, name: string, authType: "preshared"|"user", region: oracleBucket.oracleRegions}>([
      {
        name: "namespace",
        type: "input"
      },
      {
        name: "name",
        type: "input"
      },
      {
        name: "authType",
        type: "list",
        choices: [
          {
            name: "Pre autenticated key",
            value: "preshared"
          },
          {
            name: "User",
            value: "user"
          },
        ]
      },
      {
        name: "region",
        type: "list",
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
      },
    ]);
    return {
      type: "oracle_bucket",
      authConfig: {
        namespace,
        name,
        region,
        auth: (authType === "preshared" ? {
          type: "preAuthentication",
          PreAuthenticatedKey: await simpleQuestion({type: "input", message: "Key"}),
        } : {
          type: "user",
          user: await simpleQuestion({type: "input", message: "User"}),
          tenancy: await simpleQuestion({type: "input", message: "Tenancy"}),
          privateKey: await simpleQuestion({type: "input", message: "privateKey"}),
          fingerprint: await simpleQuestion({type: "input", message: "fingerprint"}),
          passphase: !await simpleQuestion({type: "confirm", message: "Private key required Passworld?"}) ? undefined : await simpleQuestion({
            type: "password",
            mask: "*"
          }),
        })
      }
    };
  } else if (target === "github") {
    const { owner, repository, token, type } = await inquirer.prompt<{owner: string, repository: string, token?: string, type: "branch"|"release"}>([
      {
        type: "input",
        name: "owner"
      },
      {
        type: "input",
        name: "repository"
      },
      {
        type: "password",
        name: "Token",
        mask: "*",
      },
      {
        type: "list",
        name: "type",
        choices: [
          "branch",
          "release"
        ]
      }
    ]);
    const gh = await Github.GithubManeger(owner, repository, token);
    return {
      type: "github",
      owner,
      repository,
      ...(type === "branch" ? {
        subType: "branch",
        branch: ""
      } : {
        subType: "release",
        tag: await simpleQuestion<string[]>({
          type: "checkbox",
          choices: (await gh.getRelease()).filter(({assets}) => assets.find(a => a.name.endsWith(".deb"))).map(({tag_name}) => tag_name),
        }),
      })
    };
  } else if (target === "docker") {
    const basicConfig = await inquirer.prompt<{authConfirm: boolean, imageURI: string}>([
      {
        name: "imageURI",
        type: "input",
        message: "Image URI/URL:",
        validate(input) {
          try {
            new dockerRegistry.parseImage(input);
            return true;
          } catch (err) {
            return String(err?.message || err);
          }
        },
      },
      {
        name: "authConfirm",
        type: "confirm",
        message: "This registry or image required authentication?"
      }
    ]);
    let auth: dockerRegistry.userAuth;
    if (basicConfig.authConfirm) {
      const authPrompts = await inquirer.prompt([
        {
          name: "user",
          type: "input",
          message: "Username:",
          validate(input: string) {
            if (input.trim().length > 1) return true;
            return "Invalid username";
          }
        },
        {
          name: "pass",
          type: "password",
          mask: "*",
          message: "Password or Token:"
        },
      ]);
      auth = {
        username: authPrompts.user,
        password: authPrompts.pass
      };
    }

    const registry = new dockerRegistry.v2(basicConfig.imageURI, auth);
    const tags = await simpleQuestion<string[]>({
      type: "checkbox",
      message: "Select tags or don't select any to go to the last 6 tags at sync time",
      choices: (await registry.getTags())
    });

    return {
      type: "docker",
      image: basicConfig.imageURI,
      auth,
      tags
    };
  }

  console.log("Try again");
  return createSource();
}

async function deleteSource(sources: aptStreamConfig["repository"][string]["source"]) {
  const selected = await simpleQuestion<number[]>({
    type: "checkbox",
    message: "Select sources to remove",
    choices: sources.map(({type}, index) => ({name: type, value: index}))
  });
  return sources.filter((_, index) => !selected.includes(index));
}

async function manegerSource(config: aptStreamConfig, repositoryName: string): Promise<aptStreamConfig> {
  if (config.repository[repositoryName].source.length <= 0) config.repository[repositoryName].source.push(await createSource());
  const target = await simpleQuestion<"return"|"new"|"delete"|"deleteMe">({
    type: "list",
    message: "Select repository action",
    choices: [
      {name: "New source", value: "new"},
      {name: "Delete sources", value: "delete"},
      {name: "Delete this repository", value: "deleteMe"},
      {name: "Return to menu", value: "return"},
    ]
  });

  if (target !== "return") {
    if (target === "new") config.repository[repositoryName].source.push(await createSource());
    else if (target === "delete") config.repository[repositoryName].source = await deleteSource(config.repository[repositoryName].source);
    else if (target === "deleteMe") {
      if (await simpleQuestion<boolean>({
        type: "confirm",
        message: "Are you sure what you're doing, can this process be irreversible?"
      })) {
        delete config.repository[repositoryName];
        console.log("Repository (%O) deleted from config file!", repositoryName);
        return config;
      }
      console.log("Repository delete aborted!");
    }
    return manegerSource(config, repositoryName);
  }
  return config;
}

async function genGPG(config: aptStreamConfig): Promise<aptStreamConfig> {
  if (config.gpgSign) console.warn("Replacing exists gpg keys");

  const ask = await inquirer.prompt([
    {
      type: "input",
      message: "Full name or nickname, example Google Inc.:",
      name: "name",
    },
    {
      type: "input",
      message: "email, example: noreply@gmail.com:",
      name: "email"
    },
    {
      type: "password",
      mask: "*",
      message: "password to encrypt the gpg files, if you don't want to leave it blank",
      name: "pass",
      validate(input = "") {
        if (input.length === 0) return true;
        else if (input.length >= 8) return true;
        return "Password must have more than 8 characters!";
      },
    },
    {
      type: "password",
      mask: "*",
      name: "passConfirm",
      when: (answers) => answers.pass?.length > 0,
      validate(input, answers) {
        if (input === answers.pass) return true;
        return "Invalid password, check is same!";
      },
    },
    {
      type: "confirm",
      message: "Want to save keys locally?",
      name: "confirmSaveGPG",
    },
    {
      type: "input",
      message: "Which folder do you save?",
      name: "folderPath",
      default: path.resolve(process.cwd(), "gpgKeys"),
      when: (answers) => answers.confirmSaveGPG
    }
  ]);
  return openpgp.generateKey({
    rsaBits: 4096,
    format: "armored",
    type: "rsa",
    passphrase: ask.pass,
    userIDs: [{
      comment: "Generated by apt-stream",
      name: ask.name,
      email: ask.email,
    }],
  }).then(async keys => {
    config.gpgSign = {
      authPassword: ask.pass,
      private: {
        content: keys.privateKey,
      },
      public: {
        content: keys.publicKey,
      }
    };
    if (ask.confirmSaveGPG) {
      const folderPath = path.resolve(process.cwd(), ask.folderPath);
      if (!(await extendsFS.exists(folderPath))) await fs.mkdir(folderPath, {recursive: true});
      config.gpgSign.private.path = path.join(folderPath, "privateAptStream.gpg");
      config.gpgSign.public.path = path.join(folderPath, "publicAptStream.gpg");
    }
    return config;
  }).catch(err => {
    console.error(err?.message || err);
    return genGPG(config);
  });
}

export default async function main(configPath: string, configOld?: aptStreamConfig) {
  if (configOld) {
    console.log("Saving current config...");
    await save(configPath, configOld);
  }
  const localConfig = !configOld ? await config(configPath) : configOld;
  if (Object.keys(localConfig.repository).length === 0) {
    console.log("Init fist repository config!");
    return createRepository(localConfig).then(d => main(configPath, d));
  }
  const target = await simpleQuestion<"new"|"gpg"|"edit"|"load"|"exit">({
    type: "list",
    message: "Select action",
    choices: [
      {name: "Edit repository", value: "edit"},
      {name: "Create new Repository", value: "new"},
      {name: "(Re)generate gpg keys", value: "gpg"},
      {name: "Sync repository", value: "load"},
      {name: "Exit", value: "exit"}
    ]
  });
  if (target !== "exit") {
    if (target === "new") configOld = await createRepository(localConfig);
    if (target === "gpg") configOld = await genGPG(localConfig);
    else if (target === "edit") {
      const repoName = await simpleQuestion<string>({
        type: "list",
        message: "Select repository",
        choices: Object.keys(localConfig.repository)
      });
      configOld = await manegerSource(localConfig, repoName);
    } else if (target === "load") {
      console.log("Saving...");
      await save(configPath, localConfig);
      console.log("Now loading all packages");
      const sync = new syncRepository();
      sync.on("error", console.error);
      sync.on("addPackage", data => console.log("Added: %s -> %s/%s %s/%s", data.distName, data.componentName, data.control.Package, data.control.Version, data.control.Architecture, data.componentName));
      return sync.sync(await connect(localConfig), localConfig);
    }
    return main(configPath, configOld);
  }
  console.log("Saving...");
  await save(configPath, localConfig);
}