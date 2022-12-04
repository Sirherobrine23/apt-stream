import * as yaml from "yaml";
import fs from "node:fs/promises";
import {extendFs} from "@sirherobrine23/coreutils";

export type configV1 = {
  version: 1,
  repos: {
    repo: string|{
      owner: string,
      repo: string
    },
    from?: "oci"|"release"|"oci+release"|"auto",
    auth?: {
      username?: string,
      password?: string
    }
  }[]
};

export async function getConfig(filePath: string): Promise<configV1> {
  if (!await extendFs.exists(filePath)) throw new Error("file not exists");
  const configData: configV1 = yaml.parse(await fs.readFile(filePath, "utf8"));
  return {
    version: 1,
    repos: configData?.repos?.map(({repo, auth, from}) => ({
      repo,
      from: from||"auto",
      auth
    }))||[]
  };
}
