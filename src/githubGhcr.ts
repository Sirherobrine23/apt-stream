import type { manifestOptions } from "@sirherobrine23/coreutils/src/DockerRegistry/manifests.js";
import { createExtract } from "./ar.js";
import { WriteStream } from "node:fs";
import { Writable } from "node:stream";
// import { registerFunction } from "./aptRepo/repoConfig.js";
import coreUtils, { DockerRegistry } from "@sirherobrine23/coreutils";
import path from "node:path";
import tar from "tar";
import os from "node:os";

export async function list(repo: string|manifestOptions, config?: DockerRegistry.Manifest.optionsManifests) {
  console.log("testing %o", repo);
  const dockerRegistry = await coreUtils.DockerRegistry.Manifest.Manifest(repo, config);
  const layers = await dockerRegistry.imageManifest(dockerRegistry.repoConfig.tagDigest);
  for (const layer of layers.layers) {
    console.log("Docker image %o testing %s", dockerRegistry.repoConfig, layer.digest);
    const files: {path: string, size: number, config?: string}[] = [];
    const piped = (await coreUtils.httpRequest.pipeFetch({url: dockerRegistry.endpointsControl.blob.get_delete(layer.digest), headers: {Authorization: `Bearer ${await DockerRegistry.Utils.getToken(dockerRegistry.repoConfig)}`}})).pipe(tar.t({
      async onentry(entry) {
        if (!entry.path.endsWith(".deb")) return;
        const ar = entry.pipe(createExtract());
        await new Promise<void>(done => {
          ar.once("entry", (info, stream) => {
            if (info.name !== "control.tar.gz") return;
            stream.pipe(tar.extract({
              onentry: (tarEntry) => {
                if (tarEntry.path !== "control") return;
                let controlBuffer: Buffer;
                tarEntry.on("data", (chunk) => {
                  if (!controlBuffer) controlBuffer = chunk;
                  else controlBuffer = Buffer.concat([controlBuffer, chunk]);
                });
                tarEntry.on("end", () => {
                  files.push({
                    path: entry.path,
                    size: entry.bufferLength,
                    config: controlBuffer.toString()
                  });
                  done();
                });
              }
            }));
          });
        });
      }
    }));
    await new Promise<void>(done => piped.on("end", done));
    if (files.length === 0) continue;
    return {
      files,
      stream: async (file: string, res: WriteStream|Writable) => {
        if (!files.some(({path}) => file === path)) throw new Error("Invalid file");
        const piped = (await coreUtils.httpRequest.pipeFetch({url: dockerRegistry.endpointsControl.blob.get_delete(layer.digest), headers: {Authorization: `Bearer ${await DockerRegistry.Utils.getToken(dockerRegistry.repoConfig)}`}})).pipe(tar.x({
          onentry: async (entry) => {
            if (!res.writable) {
              piped.end();
              return;
            }
            if (file !== entry.path) return;
            entry.pipe(res);
            await new Promise(done => res.once("unpipe", done));
            piped.end();
            return;
          }
        }));
        return new Promise<void>(done => piped.once("finish", done));
      }
    };
  }
  return {};
}

export async function localRepo(repo: string) {
  const tmpStorage = path.join(process.env.TMPSTORAGE ? path.resolve(process.env.TMPSTORAGE) : os.tmpdir(), ".ghcrDownloads");
  const dockerRegistry = await coreUtils.DockerRegistry.Manifest.Manifest(repo);
  // const data = await dockerRegistry.imageManifest();
  return (await coreUtils.DockerRegistry.Download.downloadBlob(dockerRegistry.repoConfig, {storage: tmpStorage}));
}