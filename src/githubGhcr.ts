import { Docker, extendFs, httpRequestLarge } from "@sirherobrine23/coreutils";
import path from "node:path";
import os from "node:os";
const tmpStorage = path.join(process.env.TMPSTORAGE ? path.resolve(process.env.TMPSTORAGE) : os.tmpdir(), ".ghcrDownloads");

export async function listFilesToRepo(repo: string) {
  const repoConfig = Docker.Manifest.toManifestOptions(repo);
  const manifest = await Docker.Manifest.getManifest(repoConfig);
  const downloadToken = await Docker.Manifest.getToken(repoConfig);
  if (manifest.layers.some((layer: (typeof manifest.layers)[number]) => !(layer.mediaType.endsWith("gzip")||layer.mediaType.endsWith("tar")))) throw new Error("Layer manifest includes not extrected layer by node-tar");
  const layersFile = await Promise.all(manifest.layers.map(async (layer: (typeof manifest.layers)[number]) => {
    const rootSave = path.join(tmpStorage, layer.digest);
    await httpRequestLarge.tarExtract({
      url: `http://${repoConfig.registryBase}/v2/${repoConfig.owner}/${repoConfig.repository}/blobs/${layer.digest}`,
      folderPath: rootSave,
      headers: {
        Authorization: `Bearer ${downloadToken}`
      }
    });
    return {
      rootSave,
      files: (await extendFs.readdirrecursive(rootSave)).filter((file: string) => file.endsWith(".deb")) as string[],
      layer: {
        size: layer.size,
        digest: layer.digest
      }
    };
  }));
  return layersFile;
}