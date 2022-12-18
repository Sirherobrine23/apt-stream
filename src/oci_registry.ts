import { debReturn, extractDebControl } from "./deb.js";
import { DockerRegistry } from "@sirherobrine23/coreutils";
import { Readable } from "stream";
import tar from "tar";

export default fullConfig;
export async function fullConfig(imageInfo: {image: string, targetInfo?: DockerRegistry.Manifest.platfomTarget}, fn: (data: debReturn & {getStream: () => Promise<Readable>}) => void) {
  const registry = await DockerRegistry.Manifest.Manifest(imageInfo.image, imageInfo.targetInfo);
  await registry.layersStream((data) => {
    if (!(["gzip", "gz", "tar"]).some(ends => data.layer.mediaType.endsWith(ends))) {
      console.log(data.layer.mediaType);
      return null;
    }
    return data.stream.pipe(tar.list({
      async onentry(entry) {
        if (!entry.path.endsWith(".deb")) return null;
        const control = await extractDebControl(entry as any);
        return fn({
          ...control,
          getStream: async () => {
            return new Promise<Readable>((done, reject) => registry.blobLayerStream(data.layer.digest).then(stream => stream.pipe(tar.list({
              onentry(getEntry) {
                if (getEntry.path === entry.path) return done(getEntry as any);
              }
            }))).catch(reject));
          },
        });
      },
    }));
  });
}