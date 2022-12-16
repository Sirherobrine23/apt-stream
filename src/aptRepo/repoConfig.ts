import coreUtils, { DockerRegistry } from "@sirherobrine23/coreutils";
import { Readable } from "node:stream";
import * as yaml from "yaml";
import fs from "node:fs/promises";

export type packagesObject = {
  name: string,
  getStrem: () => Promise<Readable>,
  version: string,
  arch: string,
  signature?: {
    sha256: string,
    md5: string,
  },
  packageConfig?: {
    [key: string]: string;
  }
};

type localRegister = {
  [name: string]: {
    [version: string]: {
      [arch: string]: {
        getStream: packagesObject["getStrem"],
        config?: packagesObject["packageConfig"],
        signature?: packagesObject["signature"],
      }
    }
  }
};

export class packageRegister {
  public packageRegister: localRegister = {};
  public registerPackage(packageConfig: packagesObject) {
    packageConfig.name = packageConfig.name?.toLowerCase()?.trim();
    packageConfig.version = packageConfig?.version?.trim();
    if (!this.packageRegister) this.packageRegister = {};
    if (!this.packageRegister[packageConfig.name]) this.packageRegister[packageConfig.name] = {};
    if (!this.packageRegister[packageConfig.name][packageConfig.version]) this.packageRegister[packageConfig.name][packageConfig.version] = {};
    console.log("[Internal package maneger]: Registry %s with version %s and arch %s", packageConfig.name, packageConfig.version, packageConfig.arch);
    this.packageRegister[packageConfig.name][packageConfig.version][packageConfig.arch] = {
      getStream: packageConfig.getStrem,
      config: packageConfig.packageConfig,
      signature: packageConfig.signature,
    };
  }
}

export function parseDebControl(control: string|Buffer) {
  if (Buffer.isBuffer(control)) control = control.toString();
  const controlObject: {[key: string]: string} = {};
  for (const line of control.split(/\r?\n/)) {
    if (/^[\w\S]+:/.test(line)) {
      const [, key, value] = line.match(/^([\w\S]+):(.*)$/);
      controlObject[key.trim()] = value.trim();
    } else {
      controlObject[Object.keys(controlObject).at(-1)] += line;
    }
  }
  return controlObject;
}

export type configV1 = {
  version: 1,
  repos: {
    repo: string|{
      owner: string,
      repo: string
    },
    from?: "oci"|"release"|"oci+release",
    ociConfig?: DockerRegistry.Manifest.optionsManifests,
    auth?: {
      username?: string,
      password?: string
    }
  }[]
};

export async function getConfig(filePath: string): Promise<configV1> {
  if (!await coreUtils.extendFs.exists(filePath)) throw new Error("file not exists");
  const configData: configV1 = yaml.parse(await fs.readFile(filePath, "utf8"));
  return {
    version: 1,
    repos: configData?.repos?.map(({repo, auth, from, ociConfig}) => ({
      repo,
      from: from||"oci",
      ociConfig,
      auth,
    }))||[]
  };
}
