import { Repository, aptStreamConfig, repositorySource } from "./config.js";
import connectDb, { packageManeger } from "./packages.js";
import { googleDriver } from "@sirherobrine23/cloud";
import { readFile } from "fs/promises";
import { apt } from "@sirherobrine23/dpkg";
import inquirerFileTreeSelection from "inquirer-file-tree-selection-prompt";
import * as dockerRegistry from "@sirherobrine23/docker-registry";
import coreHTTP from "@sirherobrine23/http";
import inquirer from "inquirer";
import path from "node:path";
import { MongoClient } from "mongodb";
inquirer.registerPrompt("file-tree-selection", inquirerFileTreeSelection);

export default async function main(configOrigin: string) {
  const config = new aptStreamConfig(configOrigin);
  if (!config.databaseAvaible()) await setDatabse(config);
  const configManeger = await connectDb(config);
  while(true) {
    const action = (await inquirer.prompt<{initAction: "serverEdit"|"newRepo"|"del"|"editRepo"|"syncRepo"|"exit"}>({
      name: "initAction",
      type: "list",
      message: "Select action:",
      choices: [
        {
          name: "Edit repository",
          value: "editRepo"
        },
        {
          name: "Create new repository",
          value: "newRepo"
        },
        {
          name: "Delete repository",
          value: "del"
        },
        {
          name: "Edit server configs",
          value: "serverEdit"
        },
        {
          name: "Exit",
          value: "exit"
        }
      ]
    })).initAction;
    if (action === "exit") break;
    else if (action === "newRepo") {
      const repoName = (await inquirer.prompt({
        name: "repoName",
        message: "Repository name:",
        type: "input",
        validate: (name) => configManeger.hasSource(name.trim()) ? "Type other repository name, this are exist's" : true,
      })).repoName.trim();
      if (repoName) await editRepository(configManeger.createRepository(repoName), configManeger);
      else console.log("The repository was not created, cancelling!");
    } else if (action === "editRepo") {
      const repo = configManeger.getRepositorys();
      const repoSelected = (await inquirer.prompt({
        name: "repo",
        message: "Selecte repository:",
        type: "list",
        choices: [
          {
            name: "Cancel",
            value: "exit"
          },
          ...(repo.map(d => d.repositoryName))
        ],
      })).repo;
      if (repoSelected !== "exit") await editRepository(configManeger.getRepository(repoSelected), configManeger);
    } else if (action === "del") {
      const repo = configManeger.getRepositorys();
      const repoSelected = (await inquirer.prompt({
        name: "repo",
        message: "Selecte repository:",
        type: "list",
        choices: [
          {
            name: "Cancel",
            value: "exit"
          },
          ...(repo.map(d => d.repositoryName))
        ],
      })).repo;
      if (repoSelected !== "exit") {
        if (configManeger.deleteRepository(repoSelected)) console.log("Repository deleted");
        else console.error("Fail to delete repository!");
      }
    } else if (action === "serverEdit") await serverConfig(configManeger);
    await configManeger.saveConfig().catch(() => {});
  }

  return configManeger.close().then(async () => configManeger.saveConfig());
}

async function serverConfig(config: packageManeger) {
  // config.setRelease
}

async function setDatabse(repo: aptStreamConfig) {
  const promps = await inquirer.prompt([
    {
      name: "url",
      type: "input",
      message: "Mongodb URL:",
      async validate(input) {
        try {
          await (await (new MongoClient(input)).connect()).close(true);
          return true;
        } catch (err) {
          return err?.message || err;
        }
      },
    },
  ]);
  repo.setDatabse(promps.url);
}

async function editRepository(repo: Repository, configManeger: packageManeger) {
  let exitShowSync = false;
  while (true) {
    const action = (await inquirer.prompt({
      name: "action",
      message: "Repository actions:",
      type: "list",
      choices: [
        {
          name: "New repository sources",
          value: "add"
        },
        {
          name: "Delete sources",
          value: "del"
        },
        {
          name: "Delete all sources",
          value: "delAll"
        },
        {
          name: "Set repository codename",
          value: "setCodename"
        },
        {
          name: "Set repository description",
          value: "setDescription"
        },
        {
          name: "Set repository label",
          value: "setLabel"
        },
        {
          name: "Set repository origin",
          value: "setOrigin"
        },
        {
          name: "Set repository suite",
          value: "setSuite"
        },
        {
          name: "Return",
          value: "exit"
        },
      ]
    })).action;

    if (action === "exit") break;
    else if (action === "setCodename") {
      const input = (await inquirer.prompt({
        name: "value",
        type: "input",
        message: "What is new Codename?"
      })).value;
      repo.setCodename(input);
    } else if (action === "setDescription") {
      const input = (await inquirer.prompt({
        name: "value",
        type: "input",
        message: "Set description in one single line:"
      })).value;
      repo.setDescription(input);
    } else if (action === "setLabel") {
      const input = (await inquirer.prompt({
        name: "value",
        type: "input",
        message: "Set label:"
      })).value;
      repo.setLabel(input);
    } else if (action === "setOrigin") {
      const input = (await inquirer.prompt([
        {
          when: () => !!repo.getOrigin(),
          name: "confirm",
          message: "Are you sure you want to change Origin?",
          type: "confirm",
          default: false
        },
        {
          when: (ask) => !repo.getOrigin() || ask["confirm"],
          name: "value",
          type: "input",
          message: "What is Origin name?"
        }
      ])).value;
      if (!input) console.log("Canceled set origin"); else repo.setOrigin(input);
    } else if (action === "setSuite") {
      const input = (await inquirer.prompt({
        name: "value",
        type: "input",
        message: "What is Suite name?"
      })).value;
      repo.setSuite(input);
    } else if (action === "delAll") {
      exitShowSync = true;
      repo.clear();
    } else if (action === "del") {
      const srcs = repo.getAllRepositorys();
      if (!srcs.length) {
        console.info("Not sources!");
        continue;
      }
      const sel: string[] = (await inquirer.prompt({
        name: "sel",
        type: "checkbox",
        message: "Select IDs:",
        choices: repo.getAllRepositorys().map(d => ({name: `${d.repositoryID} (${d.type})`, value: d.repositoryID})),
      })).sel;
      exitShowSync = true;
      sel.forEach(id => repo.delete(id));
    } else if (action === "add") {
      const root = async () => createSource().catch(err => {
        console.error(err);
        console.log("Try again");
        return createSource();
      });
      repo.set(configManeger.createRepositoryID(), await root());
    }
  }
  if (exitShowSync) console.info("Sync packages!");
  return repo;
}

async function createSource(): Promise<repositorySource> {
  let { srcType, componentName } = (await inquirer.prompt<{srcType: repositorySource["type"], componentName?: string}>([
    {
      name: "srcType",
      type: "list",
      choices: [
        {
          value: "http",
          name: "HTTP Directly"
        },
        {
          value: "mirror",
          name: "APT Mirror"
        },
        {
          value: "github",
          name: "Github Release/Branch"
        },
        {
          value: "googleDriver",
          name: "Google Drive"
        },
        {
          value: "oracleBucket",
          name: "Oracle Cloud Infracture Bucket"
        },
        {
          value: "docker",
          name: "OCI (Open Container Iniciative)/Docker Image"
        },
      ]
    },
    {
      type: "confirm",
      name: "addComp",
      message: "Add component name?",
      default: false
    },
    {
      name: "componentName",
      when: (answers) => answers["addComp"],
      type: "input",
      default: "main",
      validate: (inputComp) => (/[\s]+/).test(inputComp) ? "Remove Spaces" : true
    }
  ]));
  componentName ||= "main";
  if (srcType === "http") {
    return {
      type: "http", componentName,
      url: (await inquirer.prompt({
        name: "reqUrl",
        type: "input",
        validate: (urlInput) => {try {new URL(urlInput); return true} catch (err) { return err?.message || String(err); }}
      })).reqUrl,
    };
  } else if (srcType === "mirror") {
    const promps = (await inquirer.prompt([
      {
        type: "list",
        name: "sourceFrom",
        choices: [
          {name: "Select file", value: "fileSelect"},
          {name: "Create from scrat", value: "createIt"}
        ]
      },
      {
        when: (answers) => answers["sourceFrom"] === "fileSelect",
        name: "fileSource",
        type: "file-tree-selection",
        default: process.cwd(),
        message: "Select file source path:"
      },
      {
        when: (answers) => answers["sourceFrom"] !== "fileSelect",
        name: "fileSource",
        type: "editor",
        message: "creating sources",
        default: "# This is comment\ndeb http://example.com example main",
      }
    ]));

    return {
      type: "mirror", componentName,
      config: (apt.parseSourceList(promps["sourceFrom"] !== "fileSelect" ? promps["fileSource"] : await readFile(promps["fileSource"], "utf8"))).filter(src => src.type === "packages")
    };
  } else if (srcType === "github") {
    const promps = await inquirer.prompt([
      {
        name: "token",
        type: "input",
        message: "Github token to private repositorys (it is not necessary if it is public):",
        validate(input: string) {
          if (input.length > 0) if (!(input.startsWith("ghp_"))) return "Invalid token, if old token set manualy in Config file!";
          return true;
        },
      },
      {
        name: "owner",
        type: "input",
        message: "Repository owner:",
        async validate(input, ask) {
          try {
            const apiReq = new URL(path.posix.join("/users", path.posix.resolve("/", input)), "https://api.github.com");
            await coreHTTP.jsonRequestBody(apiReq, {headers: ask.token ? {Authorization: `token ${ask.token}`}:{}});
            return true;
          } catch (err) {
            return err?.body?.message || err?.message || String(err);
          }
        }
      },
      {
        name: "repository",
        type: "list",
        message: "Select repository:",
        async choices(answers) {
          const apiReq = new URL(path.posix.join("/users", answers["owner"], "repos"), "https://api.github.com");
          return (await coreHTTP.jsonRequestBody<{name: string}[]>(apiReq, {headers: answers.token ? {Authorization: `token ${answers.token}`}:{}})).map(({name}) => name);
        },
      },
      {
        name: "subType",
        type: "list",
        message: "Where to get the .deb files?",
        choices: [
          "Release",
          "Branch"
        ]
      }
    ]);

    const { owner, repository, token } = promps;
    if (promps["subType"] === "Branch") {
      return {
        type: "github", subType: "branch", componentName, enableUpload: false,
        owner, repository, token,
        branch: (await inquirer.prompt({
          name: "branch",
          type: "list",
          message: "Select the branch:",
          async choices() {
            const apiReq = new URL(path.posix.join("/repos", owner, repository, "branches"), "https://api.github.com");
            return (await coreHTTP.jsonRequestBody<{name: string}[]>(apiReq)).map(({name}) => name);
          }
        })).branch,
      };
    }
    const { tag, enableUpload } = await inquirer.prompt([
      {
        when: () => !!token,
        type: "confirm",
        name: "enableUpload",
        message: "Enable support to upload files to Github Release?",
        default: false,
      },
      {
        name: "tag",
        type: "checkbox",
        message: "Select tags:",
        async choices() {
          const apiReq = new URL(path.posix.join("/repos", owner, repository, "releases"), "https://api.github.com");
          return (await coreHTTP.jsonRequestBody<{tag_name: string}[]>(apiReq)).map(({tag_name}) => tag_name);
        }
      },
    ]);
    return {
      type: "github", subType: "release", componentName, enableUpload,
      owner, repository, token,
      tag,
    }
  } else if (srcType === "googleDriver") {
    const clientPromp = await inquirer.prompt([
      {
        type: "input",
        name: "secret",
        message: "Google oAuth Client Secret:"
      },
      {
        type: "input",
        name: "id",
        message: "Google oAuth Client ID:"
      },
      {
        type: "confirm",
        name: "enableUpload",
        message: "Enable support to upload files to Google driver?",
        default: false,
      },
      {
        name: "listFiles",
        type: "confirm",
        message: "After authenticating Google Drive, will you want to select the files?"
      },
      {
        when: (ask) => ask["listFiles"],
        name: "folderID",
        type: "input",
        message: "Folder ID?"
      }
    ]);
    let clientToken: any;
    const gdrive = await googleDriver.GoogleDriver({
      clientSecret: clientPromp["secret"],
      clientID: clientPromp["id"],
      callback(err, data) {
        if (err) throw err;
        if (data.authUrl) return console.info("Open %O to complete Google Drive Auth", data.authUrl);
        clientToken = data.token;
      },
    });
    let gIDs: string[];
    if (clientPromp["listFiles"]) {
      const folderID = clientPromp["folderID"]||undefined;
      const files = (await gdrive.listFiles(folderID)).filter(file => file.name.endsWith(".deb"));
      if (files.length <= 0) console.log("No files currently in you drive");
      else gIDs = (await inquirer.prompt({
        name: "ids",
        type: "checkbox",
        choices: files.map(file => ({name: file.name, value: file.id, checked: true}))
      })).ids;
    }

    return {
      type: "googleDriver", componentName, enableUpload: clientPromp["enableUpload"],
      clientSecret: clientPromp["secret"],
      clientId: clientPromp["id"],
      clientToken,
      gIDs
    };
  } else if (srcType === "oracleBucket") {
    const ociPromps = await inquirer.prompt([
      {
        name: "namespace",
        type: "input",
        message: "OCI Bucket namespace:"
      },
      {
        name: "name",
        type: "input",
        message: "Bucket name:"
      },
      {
        name: "region",
        type: "list",
        message: "Select Bucket region:",
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
      {
        name: "authType",
        type: "list",
        choices: [
          {name: "OCI Cli config", value: "preAuthentication"},
          {name: "User", value: "user"},
        ]
      },
      {
        when: (answers) => answers["authType"] !== "preAuthentication",
        name: "tenancy",
        type: "input"
      },
      {
        when: (answers) => answers["authType"] !== "preAuthentication",
        name: "user",
        type: "input"
      },
      {
        when: (answers) => answers["authType"] !== "preAuthentication",
        name: "fingerprint",
        type: "input"
      },
      {
        when: (answers) => answers["authType"] !== "preAuthentication",
        name: "privateKey",
        type: "input"
      },
      {
        when: (answers) => answers["authType"] !== "preAuthentication",
        name:  "passphase",
        type: "confirm",
        message: "Private key require password to decrypt?"
      },
      {
        when: (answers) => answers["passphase"],
        name:  "passphase",
        type: "password",
        mask: "*"
      },
      {
        type: "confirm",
        name: "enableUpload",
        message: "Enable support to upload files?",
        default: false,
      }
    ]);
    const { namespace, name, region, enableUpload } = ociPromps;
    if (ociPromps["authType"] === "preAuthentication") return {
      type: "oracleBucket", componentName, enableUpload,
      authConfig: {
        namespace, name, region
      }
    };
    const { fingerprint, privateKey, tenancy, user, passphase } = ociPromps;
    return {
      type: "oracleBucket", componentName, enableUpload,
      authConfig: {
        namespace, name, region,
        auth: {
          fingerprint, privateKey, tenancy, user, passphase
        }
      }
    };
  } else if (srcType === "docker") {
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
        message: "This registry or image required authentication?",
        default: false
      }
    ]);
    let auth: dockerRegistry.userAuth;
    let enableUpload: boolean = false;
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
        {
          name: "enableUpload",
          type: "confirm",
          message: "Allow publish packages in Docker registry?"
        }
      ]);
      enableUpload = authPrompts["enableUpload"];
      auth = {
        username: authPrompts.user,
        password: authPrompts.pass
      };
    }

    return {
      type: "docker", componentName, enableUpload,
      image: basicConfig.imageURI,
      auth
    };
  }

  console.log("Invalid select type!");
  return createSource();
}