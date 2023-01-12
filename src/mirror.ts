import { httpRequest, DebianPackage } from "@sirherobrine23/coreutils";
import { Decompressor as lzmaDecompressor } from "lzma-native";
import openpgp from "openpgp";
import zlib from "node:zlib";
import path from "node:path";

export async function getRelease(uri: string, options: {dist: string}) {
  let Release = (await httpRequest.bufferFetch(`${uri}/dists/${options.dist}/InRelease`).catch(() => httpRequest.bufferFetch(`${uri}/dists/${options.dist}/Release`))).data.toString("utf8").trim();
  if (Release.startsWith("-----")) Release = (await openpgp.readCleartextMessage({cleartextMessage: Release})).getText();
  return DebianPackage.parseRelease(Buffer.from(Release, "utf8"));
}

export async function getPackages(uri: string, options: {dist: string, component?: string}) {
  const data: {url: string, packages: DebianPackage.debianControl[]}[] = [];
  const Release = await getRelease(uri, options);
  const urls: string[] = [];
  Release.Components.forEach(component => {
    if (options.component && options.component !== component) return;
    Release.Architectures.forEach(arch => urls.push(`${uri}/dists/${options.dist}/${component}/binary-${arch}/Packages`));
  });
  for (const packageUrl of urls) {
    const fetchData = async (url: string) => {
      return httpRequest.pipeFetch(url).then(x => {
        if (url.endsWith(".gz")) return x.pipe(zlib.createGunzip());
        if (url.endsWith(".xz")) return x.pipe(lzmaDecompressor());
        return x;
      }).then(stream => new Promise<void>((res, rej) => {
        stream.on("error", rej);
        return DebianPackage.parsePackages(stream).then(x => {
          const packages = x.filter(x => Boolean(x.Filename)).map(x => {const urlData = new URL(uri); urlData.pathname = path.posix.join(urlData.pathname, x.Filename); x.Filename = urlData.toString(); return x;});
          data.push({url: url, packages});
          res();
        }).catch(rej);
      }));
    }

    await fetchData(packageUrl).catch(() => fetchData(packageUrl + ".gz")).catch(() => fetchData(packageUrl + ".xz"));
  }

  return data;
}