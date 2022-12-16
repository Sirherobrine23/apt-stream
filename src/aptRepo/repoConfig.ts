import coreUtils, { DockerRegistry } from "@sirherobrine23/coreutils";
import * as yaml from "yaml";
import fs from "node:fs/promises";

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
