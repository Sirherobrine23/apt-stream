import coreUtils, { DockerRegistry } from "@sirherobrine23/coreutils";
import { Readable } from "node:stream";
import * as yaml from "yaml";
import fs from "node:fs/promises";

export type packagesObject = {
  name: string,
  getStrem: () => Promise<Readable>,
  version: string,
  packageConfig?: any
};

export class packageRegister {
  #packageRegister: {[name: string]: {[version: string]: {getStream: packagesObject["getStrem"], config?: packagesObject["packageConfig"]}}} = {};
  public getPackages() {
    return Object.keys(this.#packageRegister).map(packageName => {
      return {
        packageName,
        versions: Object.keys(this.#packageRegister[packageName]).map(version => ({
          version,
          getStream: this.#packageRegister[packageName][version].getStream,
          config: this.#packageRegister[packageName][version].config
        }))
      };
    });
  }

  public registerPackage(packageConfig: packagesObject) {
    packageConfig.name = packageConfig.name?.toLowerCase()?.trim();
    packageConfig.version = packageConfig?.version?.trim();
    if (!this.#packageRegister[packageConfig.name]) this.#packageRegister[packageConfig.name] = {};
    this.#packageRegister[packageConfig.name][packageConfig.version] = {
      getStream: packageConfig.getStrem,
      config: packageConfig.packageConfig,
    };
  }
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
