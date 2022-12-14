import coreUtils from "@sirherobrine23/coreutils";
import path from "node:path";
import os from "node:os";
const tmpStorage = path.join(process.env.TMPSTORAGE ? path.resolve(process.env.TMPSTORAGE) : os.tmpdir(), ".ghcrDownloads");

export async function localRepo(repo: string) {
  const dockerRegistry = await coreUtils.DockerRegistry.Manifest.Manifest(repo);
  // const data = await dockerRegistry.imageManifest();
  return (await coreUtils.DockerRegistry.Download.downloadBlob(dockerRegistry.repoConfig, {storage: tmpStorage}));
}