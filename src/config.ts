import { googleDriver, oracleBucket } from "@sirherobrine23/cloud";
import dockerRegistry from "@sirherobrine23/docker-registry";
import { apt, dpkg } from "@sirherobrine23/dpkg";
import { extendsCrypto } from "@sirherobrine23/extends";
import { Github } from "@sirherobrine23/http";
import { Collection, Db, MongoClient } from "mongodb";
import crypto from "node:crypto";
import oldFs, { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import openpgp from "openpgp";
import yaml from "yaml";

export type repositorySouce = {
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
  url: string | URL,
  enableUpload?: false;
  header?: { [key: string]: string },
  query?: { [key: string]: string }
} | {
  type: "mirror",
  enableUpload?: false;
  config: apt.sourceList;
} | {
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
} | {
  subType: "branch",
  enableUpload?: false;
  branch: string[],
}) | {
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

  /** Folder id to add files upload */
  uploadFolderID?: string;

  /**
   * Files or Folders ID's
   */
  gIDs?: string[],
} | {
  type: "oracleBucket",

  /**
   * Oracle bucket authentication
   */
  authConfig: oracleBucket.oracleOptions,

  /** Folder to upload files if enabled */
  uploadFolderPath?: string;

  /**
   * Files or Folders path
   */
  path?: string[],
} | {
  type: "docker",
  auth?: dockerRegistry.userAuth,
  image: string,
  tags?: string[]
});

export type SourceJson = {
  Description?: string;
  Codename?: string;
  Suite?: string;
  Origin?: string;
  Label?: string;
  repositorys?: {
    [src: string]: repositorySouce
  }
};
export class Source extends Map<string, repositorySouce> {
  constructor(src: SourceJson = {}) {
    super();
    if (!src) return;
    const {
      Codename,
      Description,
      Label,
      Origin,
      Suite,
      repositorys = {}
    } = src;

    this.Description = Description;
    this.Codename = Codename;
    this.Suite = Suite;
    this.Origin = Origin;
    this.Label = Label;
    Object.keys(repositorys).forEach(key => this.set(key, repositorys[key]));
  }

  Description?: string;
  Codename?: string;
  Suite?: string;
  Origin?: string;
  Label?: string;

  toJSON() {
    return Array.from(this.keys()).reduce<SourceJson>((acc, key) => {
      acc.repositorys[key] = this.get(key);
      return acc;
    }, {
      Description: this.Description,
      Codename: this.Codename,
      Suite: this.Suite,
      Label: this.Label,
      Origin: this.Origin,
      repositorys: {}
    });
  }

  toArray(): (repositorySouce & { id: string })[] {
    return Array.from(this.keys()).map(id => ({ id, ...(this.get(id)) }));
  }

  /**
   * Add new source origin to Repository and check if valid config, else throw Error.
   *
   * @param srcID - optional ID to source
   * @param value - Repository source to Repository
   */
  set(srcID: string | undefined, value: repositorySouce) {
    if (!value) throw new Error("Require value");
    else if (!(typeof value === "object" && !Array.isArray(value))) throw new Error("Require Object");
    else if (typeof value === "string" && this.has(srcID)) throw new Error("Source ID are add");
    value.componentName ||= "main";
    value.enableUpload ??= false;
    srcID ||= value.type + "_" + ([crypto.randomBytes(6).toString("hex"), crypto.randomBytes(crypto.randomInt(4, 16)).toString("hex"), crypto.randomUUID()]).join("-");

    if (value.type === "http") {
      if (!value.url) throw new Error("Require debian package file");
      else if (!(value.url instanceof URL || typeof value.url === "string" && value.url.startsWith("http"))) throw new Error("Invalid URL");
      value.enableUpload = false;

      // Test string to is valid URL
      let protocol: string;
      if (typeof value.url === "string") protocol = (new URL(value.url)).protocol;
      else protocol = value.url.protocol;
      if (!(protocol === "http:" || protocol === "https:")) throw new Error("Invalid URL, require HTTP protocol");

      value.header ||= {};
      value.query ||= {};
    } else if (value.type === "github") {
      if (!(value.owner && value.repository)) throw new Error("Require valid repository and owner");
      else if (!(typeof value.owner === "string" && value.owner.length > 1)) throw new Error("Require valid owner username");
      else if (!(typeof value.repository === "string" && value.repository.length > 1)) throw new Error("Require valid repository name");
      value.token ||= Github.githubToken;

      if (value.subType === "release") {
        value.tag ||= [];
      } else if (value.subType === "branch") {
        value.enableUpload = false;
        value.branch ||= [];
        if (!value.branch.length) throw new Error("Require at one Branch");
      } else throw new Error("Invalid Github subtype");
    } else if (value.type === "googleDriver") {
      if (!(value.clientId && value.clientSecret && value.clientToken)) throw new Error("Require Client ID, Secret and Token auth");
      else if (!(typeof value.clientId === "string" && value.clientId.length > 5)) throw new Error("Require valid clientID");
      else if (!(typeof value.clientSecret === "string" && value.clientSecret.length > 5)) throw new Error("Require valid clientSecret");
      else if (!(typeof value.clientToken === "object" && typeof value.clientToken.access_token === "string")) throw new Error("Require valid token");
      value.gIDs ||= [];
    } else if (value.type === "oracleBucket") {
      if (!value.authConfig.region) throw new Error("Require Bucket region");
      if (value.authConfig.auth) {
        if (Array.isArray(value.authConfig.auth)) {
          if (!(value.authConfig.auth.length)) throw new Error("Require auth to Oracle Cloud");
          const backup = value.authConfig.auth.slice(0, 2);
          if (!(oldFs.existsSync(path.resolve(process.cwd(), backup.at(0))))) throw new Error("Invalid Oracle auth path, Path not exists");
          backup[0] = path.resolve(process.cwd(), backup.at(0));
          if (typeof backup.at(1) === "string") {
            if (!(backup[1] = backup[1].trim())) delete backup[1];
          } else delete backup[1];
          value.authConfig.auth = backup.filter(Boolean);
        } else {
          const { tenancy, user, fingerprint, privateKey, passphase } = value.authConfig.auth;
          if (!(tenancy && user && fingerprint && privateKey)) throw new Error("Invalid auth to Oracle Cloud");
          if (!passphase) delete value.authConfig.auth.passphase;
        }
      }
      value.path ||= [];
    } else if (value.type === "mirror") {
      value.enableUpload = false;
      if (!value.config) throw new Error("Require Mirror sources");
      else if (!((value.config = value.config.filter(at => at.type === "packages" && at.distname?.trim?.() && at.src?.trim?.())).length)) throw new Error("To mirror the repository you only need a source");
    } else if (value.type === "docker") {
      if (!value.image) throw new Error("Require docker image");
      if (value.auth) if (!(value.auth.username && value.auth.password)) throw new Error("Required valid auth to Docker image");
      value.tags ||= [];
    } else throw new Error("Invalid source type");
    super.set(srcID, value);
    return this;
  }

  async uploadFile(srcID: string, filePath: string) {
    if (!(this.has(srcID))) throw new Error("ID not exists");
    const info = this.get(srcID);
    if (!(info.enableUpload)) throw new Error("Cannot upload package");
    const { controlFile } = await dpkg.parsePackage(createReadStream(filePath));
    const debInfo = await extendsCrypto.createHashAsync(createReadStream(filePath)), fileName = `${controlFile.Package}_${controlFile.Architecture}_${controlFile.Version}.deb`;

    if (info.type === "github") await finished(createReadStream(filePath).pipe((await (await Github.repositoryManeger(info.owner, info.repository, { token: info.token })).release.manegerRelease(controlFile.Version)).uploadAsset(fileName, debInfo.byteLength)), { error: true });
    else if (info.type === "oracleBucket") await finished(createReadStream(filePath).pipe((await oracleBucket.oracleBucket(info.authConfig)).uploadFile(path.posix.join(info.uploadFolderPath || "/", fileName))));
    else if (info.type === "googleDriver") {
      const gdrive = await googleDriver.GoogleDriver({oauth: await googleDriver.createAuth({ clientID: info.clientId, clientSecret: info.clientSecret, token: info.clientToken, authUrlCallback: () => { throw new Error("Auth disabled"); }, tokenCallback: () => { }, redirectURL: null })});
      await finished(gdrive.uploadFile(fileName, info.uploadFolderID));
    } else if (info.type === "docker") {
      const oci = new dockerRegistry.v2(info.image, info.auth);
      const img = await oci.createImage(dockerRegistry.debianArchToDockerPlatform(controlFile.Architecture));
      await finished(createReadStream(filePath).pipe(img.createBlob("gzip").addEntry({ name: fileName, size: debInfo.byteLength })));
      info.tags.push((await img.finalize()).digest);
      super.set(srcID, info);
    } else throw new Error("Not implemented upload");

    return { controlFile, debInfo };
  }
}

export type ConfigJSON = {
  mongoURL?: string;
  gpg?: {
    gpgPassphrase?: string;
    privateKey: string;
    publicKey: string;
  };
  repositorys: { [repoName: string]: SourceJson };
};

export async function generateGPG({ passphrase, email, name }: { passphrase?: string, email?: string, name?: string } = {}) {
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

  return {
    privateKey,
    publicKey,
    passphrase
  };
}

export class Config extends Map<string, Source> {
  /** Mongo Server URL to connect */
  public mongoConnection: URL = new URL("mongodb://127.0.0.1/aptStream");
  public tmpFolder = tmpdir();

  public gpgPassphrase?: string;
  public privateGPG?: string;
  public publicGPG?: string;

  constructor(src?: ConfigJSON | string) {
    super();
    if (!src) return;

    if (typeof src === "string") {
      const srcc: string = src;
      try {
        src = yaml.parse(srcc);
      } catch {
        src = JSON.parse(srcc);
      }
    }

    const {
      mongoURL,
      gpg,
      repositorys = {},
    } = src as ConfigJSON;
    if (mongoURL) this.mongoConnection = new URL(mongoURL);
    if (gpg) {
      this.gpgPassphrase = gpg.gpgPassphrase;
      this.privateGPG = gpg.privateKey;
      this.publicGPG = gpg.publicKey;
    }
    Object.keys(repositorys).forEach(key => this.set(key, new Source(repositorys[key])));
  }

  /**
   * Get YAML config to easy edit
   * @returns - yaml Config
   */
  toString() { return yaml.stringify(this.toJSON()); }

  toJSON() {
    return Object.keys(this.keys()).reduce<ConfigJSON>((acc, key) => {
      acc.repositorys[key] = this.get(key).toJSON();
      return acc;
    }, {
      mongoURL: this.mongoConnection.toString(),
      ...(!(this.privateGPG && this.publicGPG) ? {} : {
        gpg: {
          gpgPassphrase: this.gpgPassphrase,
          privateKey: this.privateGPG,
          publicKey: this.publicGPG,
        }
      }),
      repositorys: {},
    });
  }

  async getPulicKey(fileType: "dearmor" | "armor" = "armor") {
    // same to gpg --dearmor
    if (fileType === "dearmor") return Buffer.from((await openpgp.unarmor(this.publicGPG)).data as any);
    return (await openpgp.readKey({ armoredKey: this.publicGPG })).armor();
  }
}

type packageCollection = {
  repositorys: {repository: string, origim: string}[];
  restoreFile: any;
  control: dpkg.debianControl;
};

export type uploadInfo = {
  ID: string;
  token: string;
  validAt: number;
  filePath: string;
  repository: string;
  destID: string;
};

export class Connection {
  constructor(public repoConfig: Config, public client: MongoClient) {
    this.database = client.db(repoConfig.mongoConnection.pathname.slice(1) || "aptStream");
    this.packageCollection = this.database.collection<packageCollection>("packages");
    this.uploadCollection = this.database.collection<uploadInfo>("uploads");
  }

  public database: Db;
  public packageCollection: Collection<packageCollection>;
  public uploadCollection: Collection<uploadInfo>;

  public getConnections() {
    const connection = this.client["topology"];
    return {
      current: Number(connection.client.s.activeSessions?.size),
      max: Number(connection.s.options.maxConnecting),
    };
  }
}

export async function Connect(repoConfig: Config) {
  const client = await (new MongoClient(repoConfig.mongoConnection.toString())).connect();
  return new Connection(repoConfig, client);
}