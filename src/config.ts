import { googleDriver, oracleBucket } from "@sirherobrine23/cloud";
import { extendsFS } from "@sirherobrine23/extends";
import { Github } from "@sirherobrine23/http";
import { apt } from "@sirherobrine23/dpkg";
import oldFs, { promises as fs } from "node:fs";
import dockerRegistry from "@sirherobrine23/docker-registry";
import openpgp from "openpgp";
import crypto from "node:crypto";
import stream from "node:stream";
import path from "node:path";
import yaml from "yaml";
import { finished } from "node:stream/promises";

export type repositorySource = {
  /**
   * Dist component
   * @default main
   */
  componentName?: string;

  /**
   * The source is available for file upload.
   */
  enableUpload?: boolean;
} & ({
  type: "http",
  enableUpload?: false;
  url: string,
  auth?: {
    header?: {[key: string]: string},
    query?: {[key: string]: string}
  }
}|{
  type: "mirror",
  enableUpload?: false;
  config: apt.sourceList
}|{
  type: "github",
  /**
   * Repository owner
   * @example `Sirherobrine23`
   */
  owner: string,
  /**
   * Repository name
   * @example `apt-stream`
   */
  repository: string,
  /**
   * Auth token, not required if public repository
   */
  token?: string,
} & ({
  subType: "release",
  tag?: string[],
}|{
  subType: "branch",
  enableUpload?: false;
  branch: string,
})|{
  type: "googleDriver",

  /**
   * oAuth Client Secret
   */
  clientSecret: string,

  /**
   * oAuth Client ID
   */
  clientId: string,

  /**
   * Client oAuth
   */
  clientToken: googleDriver.googleCredential,

  /**
   * Files or Folders ID's
   */
  gIDs?: string[],
}|{
  type: "oracleBucket",

  /**
   * Oracle bucket authentication
   */
  authConfig: oracleBucket.oracleOptions,

  /**
   * Files or Folders path
   */
  path?: string[],
}|{
  type: "docker",
  auth?: dockerRegistry.userAuth,
  image: string,
  tags?: string[]
});

export interface repositorySources {
  Description?: string;
  Codename?: string;
  Suite?: string;
  Origin?: string;
  Label?: string;
  sources: {
    [key: string]: repositorySource;
  };
}

export class Repository extends Map<string, repositorySource> {
  #Description?: string;
  setDescription(value: string) {this.#Description = value;}
  getDescription() {return this.#Description}

  #Codename?: string;
  setCodename(value: string) {this.#Codename = value;}
  getCodename() {return this.#Codename}

  #Suite?: string;
  setSuite(value: string) {this.#Suite = value;}
  getSuite() {return this.#Suite}

  #Origin?: string;
  setOrigin(value: string) {this.#Origin = value;}
  getOrigin() {return this.#Origin}

  #Label?: string;
  setLabel(value: string) {this.#Label = value;}
  getLabel() {return this.#Label}

  constructor(src?: repositorySources) {
    super();
    if (src) {
      if (Array.isArray(src["source"])) {
        console.warn("Migrating old repository to new Version");
        const aptConfig = src["aptConfig"] || {};
        this.#Description = aptConfig.Description;
        this.#Codename = aptConfig.Codename;
        this.#Origin = aptConfig.Origin;
        this.#Suite = aptConfig.Suite;
        this.#Label = aptConfig.Label;
        const old: any[] = src["source"];
        old.forEach(repo => {try {repo.type = repo.type.replace(/_([A-Z])/, (_sub, key: string) => key.toUpperCase()) as any; this.set(repo.id, repo as any)} catch {}});
        return;
      }
      this.#Description = src.Description;
      this.#Codename = src.Codename;
      this.#Origin = src.Origin;
      this.#Suite = src.Suite;
      this.#Label = src.Label;
      src.sources ||= {};
      for (const key in src.sources) {
        try {this.set(key, src.sources[key]);} catch {}
      }
    }
  }

  /**
   * Add new repository source
   *
   * @param key - Repository ID
   * @param repo - Source config
   * @returns
   */
  set(key: string, repo: repositorySource) {
    if (this.has(key)) throw new Error("ID are exists");
    if (repo["id"]) delete repo["id"];
    if (repo.type === "http") {
      if (!repo.url) throw new Error("Required URL to add this source");
      else {
        if (!(Object.keys(repo.auth?.header||{}).length) && repo.auth?.header) delete repo.auth.header;
        if (!(Object.keys(repo.auth?.query||{}).length) && repo.auth?.query) delete repo.auth.query;
      }
      if (!(Object.keys(repo.auth||{}).length) && repo.auth) delete repo.auth;
      repo.enableUpload = false;
    } else if (repo.type === "mirror") {
      if (!repo.config) throw new Error("Require Mirror sources");
      else if (!((repo.config = repo.config.filter(at => at.type === "packages" && at.distname?.trim?.() && at.src?.trim?.())).length)) throw new Error("To mirror the repository you only need a source");
      repo.enableUpload = false;
    } else if (repo.type === "github") {
      if (!(repo.owner && repo.repository)) throw new Error("github Sources require owner and repository");
      if (!repo.token) delete repo.token;
      if (repo.subType === "release") {
        if (!(repo.tag?.length)) delete repo.tag;
      } else if (repo.subType === "branch") {
        if (!(repo.branch)) delete repo.branch;
        repo.enableUpload = false;
      } else throw new Error("invalid github source");
    } else if (repo.type === "googleDriver") {
      if (!(repo.clientId && repo.clientSecret && (typeof repo.clientToken?.access_token === "string" && repo.clientToken.access_token.trim().length > 0))) throw new Error("Invalid settings to Google oAuth");
      if (!(repo.gIDs?.length)) delete repo.gIDs;
    } else if (repo.type === "oracleBucket") {
      if (!(repo.authConfig && repo.authConfig.auth)) throw new Error("Required auth config to Oracle bucket");
      else if (repo.authConfig.auth.type === "preAuthentication") {
        if (!(repo.authConfig.auth.PreAuthenticatedKey?.trim?.())) throw new Error("Invalid pre authecation key to Oracle Cloud bucket");
      } else if (repo.authConfig.auth.type === "user") {
        const { tenancy, user, fingerprint, privateKey, passphase } = repo.authConfig.auth;
        if (!(tenancy && user && fingerprint && privateKey)) throw new Error("Invalid auth to Oracle Cloud");
        if (!passphase) delete repo.authConfig.auth.passphase;
      }
      if (!(repo.path?.length)) delete repo.path;
    } else if (repo.type === "docker") {
      if (!repo.image) throw new Error("Require docker image");
      if (repo.auth) if (!(repo.auth.username && repo.auth.password)) throw new Error("Required valid auth to Docker image");
      if (!(repo.tags?.length)) delete repo.tags;
    } else throw new Error("Invalid source type");
    repo.componentName ||= "main";
    repo.enableUpload ??= false;
    super.set(key, repo);
    return this;
  }

  /**
   * Get repository source
   *
   * @param repoID - Repository ID
   * @returns repository source
   */
  get(repoID: string) {
    if (!(this.has(repoID))) throw new Error("Repository not exists");
    return super.get(repoID);
  }

  /** Get all repository sources with repository ID */
  getAllRepositorys(): ({repositoryID: string} & repositorySource)[] {
    return Array.from(this.keys()).map(key => ({repositoryID: key, ...(this.get(key))}));
  }

  /**
   * Upload debian file to repository source if avaible
   *
   * @param repositoryID - Repository ID
   * @returns
   */
  async uploadFile(repositoryID: string) {
    const repo = this.get(repositoryID);
    if (!repo.enableUpload) throw new Error("Repository not allow or not support to upload files!");
    if (repo.type === "github") {
      if (!repo.token) throw new Error("Cannot create upload file to Github Release, required Token to upload files!");
      const { owner, repository, token } = repo;
      const gh = await Github.GithubManeger(owner, repository, token);
      return {
        async githubUpload(filename: string, fileSize: number, tagName?: string): Promise<stream.Writable> {
          if (!tagName) tagName = (await gh.getRelease(true).catch(async () => (await gh.getRelease()).at(0)))?.tag_name;
          const str = new stream.PassThrough();
          (await gh.releaseManeger({tagName})).uploadFile({name: filename, content: {stream: str, fileSize}});
          return str;
        }
      };
    } else if (repo.type === "googleDriver") {
      const { clientId: clientID, clientSecret, clientToken } = repo;
      const gdrive = await googleDriver.GoogleDriver({clientID, clientSecret, token: clientToken});
      return {
        async gdriveUpload(filename: string, folderId?: string): Promise<stream.Writable> {
          const str = new stream.PassThrough();
          gdrive.uploadFile(filename, str, folderId).then(() => str.end());
          return str;
        }
      };
    } else if (repo.type === "oracleBucket") {
      const oci = await oracleBucket.oracleBucket(repo.authConfig);
      return {
        async ociUpload(filename: string): Promise<stream.Writable> {
          const str = new stream.PassThrough();
          oci.uploadFile(filename, str);
          return str;
        }
      };
    } else if (repo.type === "docker") {
      return {
        dockerUpload: async(platform: dockerRegistry.dockerPlatform, callback?: (err?: any) => void) => {
          const dockerRepo = new dockerRegistry.v2(repo.image, repo.auth);
          const img = await dockerRepo.createImage();
          const blob = img.createNewBlob("gzip");
          finished(blob).then(() => {
            const pub = () => img.publish(platform).catch(err => {
              if (err.message === "write EPIPE") return pub();
              throw err;
            });
            return pub();
          }).then(info => {
            repo.tags ||= [];
            repo.tags.push(info.digest);
            return (callback ||= () => {})();
          }, err => (callback ||= () => {})(err));
          return blob;
        }
      };
    }

    throw new Error("Not implemented");
  }

  toJSON(): repositorySources {
    return {
      Description: this.#Description,
      Codename: this.#Codename,
      Origin: this.#Origin,
      Label: this.#Label,
      sources: Array.from(this.keys()).reduce<{[key: string]: repositorySource}>((acc, key) => {acc[key] = this.get(key); return acc;}, {}),
    };
  }
}

interface serverConfig {
  portListen: number;
  clusterForks: number;
  dataStorage?: string;
  database?: {
    url: string;
    databaseName?: string;
    collectionName?: string;
  };
  gpgSign?: {
    gpgPassphrase?: string;
    privateKey: {
      keyContent: string;
      filePath?: string;
    };
    publicKey: {
      keyContent: string;
      filePath?: string;
    };
  };
}

export interface configJSON extends serverConfig {
  repository: {[repoName: string]: repositorySources};
}

export class aptStreamConfig {
  #internalServerConfig: serverConfig = { portListen: 0, clusterForks: 0 };
  #internalRepository: {[repositoryName: string]: Repository} = {};
  toJSON(): configJSON {
    const config: configJSON = Object(this.#internalServerConfig);
    if (config.dataStorage) config.dataStorage = path.relative(process.cwd(), config.dataStorage);
    config.repository = {};
    Object.keys(this.#internalRepository).forEach(repoName => config.repository[repoName] = this.#internalRepository[repoName].toJSON());
    return config;
  }

  toString(encode?: BufferEncoding, type?: "json"|"yaml") {
    encode ||= "utf8";
    type ||= "json";
    return ((["hex", "base64", "base64url"]).includes(encode) ? (encode+":") : "")+(Buffer.from((type === "yaml" ? yaml : JSON).stringify(this.toJSON()), "utf8").toString(encode || "utf8"));
  }

  #configPath?: string;
  async saveConfig(configPath?: string, type?: "json"|"yaml") {
    if (!(configPath||this.#configPath)) throw new Error("Current config only memory");
    if (this.#configPath) type ||= path.extname(this.#configPath) === ".json" ? "json" : "yaml";
    else if (configPath) type ||= path.extname(configPath) === ".json" ? "json" : "yaml";
    await fs.writeFile((configPath||this.#configPath), this.toString("utf8", type));
  }

  constructor(config?: string|configJSON|aptStreamConfig) {
    if (config) {
      let nodeConfig: configJSON;
      if (config instanceof aptStreamConfig) {
        this.#configPath = config.#configPath;
        config = config.toJSON();
      }
      if (typeof config === "string") {
        let indexofEncoding: number;
        if (path.isAbsolute(path.resolve(process.cwd(), config))) {
          if (oldFs.existsSync(path.resolve(process.cwd(), config))) config = oldFs.readFileSync((this.#configPath = path.resolve(process.cwd(), config)), "utf8")
          else {
            this.#configPath = path.resolve(process.cwd(), config);
            config = undefined;
          }
        } else if ((["hex:", "base64:", "base64url:"]).find(rel => config.toString().startsWith(rel))) config = Buffer.from(config.slice(indexofEncoding+1).trim(), config.slice(0, indexofEncoding) as BufferEncoding).toString("utf8");
        else config = undefined;
        if (!!config) {
          try {
            nodeConfig = JSON.parse(config as string);
          } catch {
            try {
              nodeConfig = yaml.parse(config as string);
            } catch {
              throw new Error("Invalid config, not is YAML or JSON");
            }
          }
        }
      } else if (typeof config === "object") nodeConfig = config;

      // Add sources
      nodeConfig ||= {clusterForks: 0, portListen: 0, repository: {}};
      nodeConfig.repository ||= {};
      Object.keys(nodeConfig.repository).forEach(keyName => this.#internalRepository[keyName] = new Repository(nodeConfig.repository[keyName]));

      // Add server config
      delete nodeConfig.repository;
      this.#internalServerConfig = {clusterForks: Number(nodeConfig.clusterForks || 0), portListen: Number(nodeConfig.portListen || 0)};
      if (nodeConfig.dataStorage) this.#internalServerConfig.dataStorage = path.resolve(process.cwd(), nodeConfig.dataStorage);
      if (nodeConfig.database?.url) {
        this.#internalServerConfig.database = {
          url: nodeConfig.database.url,
          databaseName: nodeConfig.database.databaseName || "aptStream",
          collectionName: nodeConfig.database.collectionName || "packages"
        }
      }
      if (nodeConfig.gpgSign?.privateKey && nodeConfig.gpgSign?.publicKey) {
        const { gpgPassphrase, privateKey, publicKey } = nodeConfig.gpgSign;
        if (privateKey.filePath && publicKey.filePath) {
          privateKey.keyContent = oldFs.readFileSync(privateKey.filePath, "utf8");
          publicKey.keyContent = oldFs.readFileSync(publicKey.filePath, "utf8");
        }
        this.#internalServerConfig.gpgSign = {
          gpgPassphrase: String(gpgPassphrase||""),
          privateKey: {
            keyContent: privateKey.keyContent,
            filePath: privateKey.filePath
          },
          publicKey: {
            keyContent: publicKey.keyContent,
            filePath: publicKey.filePath
          }
        };
      }
      if (!this.#internalServerConfig.gpgSign?.gpgPassphrase && typeof this.#internalServerConfig.gpgSign?.gpgPassphrase === "string") delete this.#internalServerConfig.gpgSign.gpgPassphrase;
    }
  }

  databaseAvaible() {return !!this.#internalServerConfig.database;}
  getDatabase() {
    if (!this.databaseAvaible()) throw new Error("No Database set up");
    return this.#internalServerConfig.database;
  }

  setDatabse(url: string, collectionName?: string, databaseName?: string) {
    this.#internalServerConfig.database = {
      url,
      collectionName,
      databaseName
    };
    return this;
  }

  getClusterForks() {return Number(this.#internalServerConfig.clusterForks || 0);}
  setClusterForks(value: number) {
    if (value > 0 && value < 256) this.#internalServerConfig.clusterForks = value;
    else this.#internalServerConfig.clusterForks = 0;
    return this;
  }

  setDataStorage(folderPath: string) {
    if (path.isAbsolute(folderPath)) this.#internalServerConfig.dataStorage = folderPath; else throw new Error("Require absolute path");
    return this;
  }
  async getDataStorage() {
    if (!this.#internalServerConfig.dataStorage) return undefined;
    if (!(await extendsFS.exists(this.#internalServerConfig.dataStorage))) await fs.mkdir(this.#internalServerConfig.dataStorage, {recursive: true});
    return this.#internalServerConfig.dataStorage;
  }

  getPortListen() {return Number(this.#internalServerConfig.portListen || 0);}
  setPortListen(port: number) {
    if (port >= 0 && port <= ((2**16) - 1)) this.#internalServerConfig.portListen = port;
    else throw new Error(`Invalid port range (0 - ${(2**16) - 1})`);
    return this;
  }

  setPGPKey(gpgSign: configJSON["gpgSign"]) {
    const { gpgPassphrase, privateKey, publicKey } = gpgSign;
    if (privateKey.filePath && publicKey.filePath) {
      privateKey.keyContent = oldFs.readFileSync(privateKey.filePath, "utf8");
      publicKey.keyContent = oldFs.readFileSync(publicKey.filePath, "utf8");
    }
    this.#internalServerConfig.gpgSign = {
      gpgPassphrase: String(gpgPassphrase||""),
      privateKey: {
        keyContent: privateKey.keyContent,
        filePath: privateKey.filePath
      },
      publicKey: {
        keyContent: publicKey.keyContent,
        filePath: publicKey.filePath
      }
    };

    return this;
  }

  /**
   * Generate Private and Public PGP/GPG Keys to signing repository (InRelease and Release.gpg)
   *
   * @param options - Gpg Options
   * @returns
   */
  async generateGpgKeys(options?: {passphrase?: string, email?: string, name?: string}) {
    const { passphrase, email, name } = options || {};
    const { privateKey, publicKey } = await openpgp.generateKey({
      rsaBits: 4094,
      type: "rsa",
      format: "armored",
      passphrase,
      userIDs: [
        {
          comment: "Generated in Apt-Stream",
          email, name
        }
      ]
    });
    this.#internalServerConfig.gpgSign = {
      gpgPassphrase: passphrase,
      privateKey: {keyContent: privateKey},
      publicKey: {keyContent: publicKey}
    };
    if (this.#internalServerConfig.dataStorage) {
      this.#internalServerConfig.gpgSign.privateKey.filePath = path.join(this.#internalServerConfig.dataStorage, "privateKey.gpg");
      this.#internalServerConfig.gpgSign.publicKey.filePath = path.join(this.#internalServerConfig.dataStorage, "publicKey.gpg");
      await fs.writeFile(this.#internalServerConfig.gpgSign.privateKey.filePath, this.#internalServerConfig.gpgSign.privateKey.keyContent);
      await fs.writeFile(this.#internalServerConfig.gpgSign.publicKey.filePath, this.#internalServerConfig.gpgSign.publicKey.keyContent);
    }

    return this.#internalServerConfig.gpgSign;
  }

  getPGPKey() {
    if (!this.#internalServerConfig.gpgSign) throw new Error("PGP/GPG Key not set");
    return this.#internalServerConfig.gpgSign;
  }

  async getPublicKey(type: "dearmor"|"armor"): Promise<string|Buffer> {
    const { publicKey } = this.getPGPKey();
    // same to gpg --dearmor
    if (type === "dearmor") return Buffer.from((await openpgp.unarmor(publicKey.keyContent)).data as any);
    return (await openpgp.readKey({ armoredKey: publicKey.keyContent })).armor();
  }

  /**
   * Create new source to repository.
   *
   * @param repositoryName - Repository name
   * @returns Repository class
   */
  createRepository(repositoryName: string) {
    if (this.#internalRepository[repositoryName]) throw new Error("Repository name are exists");
    return (this.#internalRepository[repositoryName] = new Repository());
  }

  /**
   *
   * @param repositoryName - Repository name, if not exists create this.
   * @param pkgSource - Packages source
   * @returns
   */
  addToRepository(repositoryName: string, pkgSource: repositorySource) {
    this.#internalRepository[repositoryName] ||= new Repository();
    this.#internalRepository[repositoryName].set(this.createRepositoryID(), pkgSource);
    return this;
  }

  createRepositoryID() {
    let repoID: string;
    while (!repoID) {
      repoID = ("aptS__")+(crypto.randomBytes(16).toString("hex"));
      if (this.getRepositorys().find(key => key.repositoryManeger.has(repoID))) repoID = undefined;
    }
    return repoID;
  }

  hasSource(repositoryName: string) {
    return !!(this.#internalRepository[repositoryName]);
  }

  /**
   * Get repository source
   * @param repositoryName - Repository name or Codename
   * @returns
   */
  getRepository(repositoryName: string) {
    if (repositoryName.startsWith("aptS__")) {
      const bc = repositoryName;
      repositoryName = undefined;
      for (const repo of Object.keys(this.#internalRepository)) if (this.#internalRepository[repo].has(bc)) {repositoryName = repo; break;}
    } else if (!this.#internalRepository[repositoryName]) {
      const bc = repositoryName;
      repositoryName = undefined;
      for (const repo of Object.keys(this.#internalRepository)) if (this.#internalRepository[repo].getCodename() === bc) {repositoryName = repo; break;}
    }
    if (!repositoryName) throw new Error("Repository not exists");
    return this.#internalRepository[repositoryName];
  }

  /**
   * Delete repository
   *
   * @param repositoryName - Repository name or Codename
   * @returns return a boolean to indicate delete status
   */
  deleteRepository(repositoryName: string) {
    if (!this.#internalRepository[repositoryName]) {
      const bc = repositoryName;
      repositoryName = undefined;
      for (const repo of Object.keys(this.#internalRepository)) if (this.#internalRepository[repo].getCodename() === bc) {repositoryName = repo; break;}
      if (!repositoryName) throw new Error("Repository not exists");
    }
    return delete this.#internalRepository[repositoryName];
  }

  getRepositorys() {
    return Object.keys(this.#internalRepository).map(repositoryName => ({repositoryName, repositoryManeger: this.#internalRepository[repositoryName]}));
  }
}