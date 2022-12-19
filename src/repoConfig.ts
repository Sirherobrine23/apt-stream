import coreUtils, { DockerRegistry } from "@sirherobrine23/coreutils";
import * as yaml from "yaml";
import fs from "node:fs/promises";

export type configV1 = {
  version: 1,
  repos: (({
    from: "release",
    repo: string|{
      owner: string,
      repo: string
    },
  }|{
    from: "oci",
    repo: string,
    ociConfig?: DockerRegistry.Manifest.platfomTarget,
  }) & {
    auth?: {
      username?: string,
      password?: string
    }
  })[]
};

export type backendConfig = {
  aptConfig?: {
    origin?: string,
    label?: string,
    enableHash?: boolean,
    sourcesList?: string
  },
  repositorys: {
    target: "oci_registry"|"github_release",
    repo: string,
  }[]
};

export async function getConfig(filePath: string): Promise<configV1> {
  if (!await coreUtils.extendFs.exists(filePath)) throw new Error("file not exists");
  const configData: configV1 = yaml.parse(await fs.readFile(filePath, "utf8"));
  return {
    version: 1,
    repos: (configData?.repos ?? []).map(data => {
      if (data.from === "oci" && typeof data.repo === "string") {
        return {
          repo: data.repo,
          from: "oci",
          auth: data.auth,
          ociConfig: data.ociConfig
        };
      }
      return {
        repo: (typeof data.repo === "string")?data.repo:{owner: data.repo.owner, repo: data.repo.repo},
        from: "release",
        auth: data.auth,
      }
    })
  };
}
