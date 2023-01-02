import { httpRequest, DebianPackage } from "@sirherobrine23/coreutils";
import { promisify } from "node:util";
import openpgp from "openpgp";
import zlib from "node:zlib";

export async function getRelease(uri: string, options: {dist: string}) {
  let Release = (await httpRequest.bufferFetch(`${uri}/dists/${options.dist}/InRelease`).catch(() => httpRequest.bufferFetch(`${uri}/dists/${options.dist}/Release`))).data.toString("utf8").trim();
  const isInrelease = Release.startsWith("-----");
  if (isInrelease) Release = (await openpgp.readCleartextMessage({cleartextMessage: Release})).getText();
  const rawData: {[key: string]: any} = {};
  let lastKey: string;
  for (const line of Release.split("\n")) {
    const llw = line.trim().toLowerCase();
    const lineSplited = line.split(": ");
    if (llw.startsWith("md5sum:")||llw.startsWith("sha1:")||llw.startsWith("sha256:")||llw.startsWith("sha512:")) {
      const [key] = line.split(":");
      rawData[key] = [];
      lastKey = key;
      continue;
    }
    if (lineSplited.length === 1) {
      if (typeof rawData[lastKey] === "string") rawData[lastKey] = [rawData[lastKey], line];
      else rawData[lastKey].push(line);
      continue;
    }
    const [key, value] = lineSplited;
    if (key && value) {
      rawData[key] = value;
      lastKey = key;
    } else {
      if ((["md5sum", "sha1", "sha256", "sha512"]).includes(key.toString().trim())) {
        if (!rawData[key.toString().trim()]) rawData[key.toString().trim()] = value;
        else if (typeof rawData[key.toString().trim()] === "string") rawData[key.toString().trim()] = [rawData[key.toString().trim()], value];
        else rawData[key.toString().trim()].push(value);
        lastKey = key.toString().trim();
      } else {
        if (typeof rawData[lastKey] === "string") rawData[lastKey] = [rawData[lastKey], key];
        else rawData[lastKey].push(key);
      }
    }
  }

  const md5 = (rawData.md5sum||rawData.MD5Sum) as string[]|undefined;
  const sha1 = (rawData.sha1||rawData.SHA1) as string[]|undefined;
  const sha256 = (rawData.sha256||rawData.SHA256) as string[]|undefined;
  const sha512 = (rawData.sha512||rawData.SHA512) as string[]|undefined;

  return {
    Origin: rawData.Origin as string|undefined,
    Label: rawData.Label as string|undefined,
    Suite: rawData.Suite as string|undefined,
    Version: rawData.Version as string|undefined,
    Codename: rawData.Codename as string|undefined,
    Changelogs: rawData.Changelogs as string|undefined,
    Date: rawData.Date ? new Date(rawData.Date) : undefined,
    "Acquire-By-Hash": Boolean(rawData["Acquire-By-Hash"] ?? false),
    Architectures: (rawData.Architectures as string|undefined)?.split(/\s+/g) as string[]|undefined,
    Components: (rawData.Components as string|undefined)?.split(/\s+/g) as string[]|undefined,
    Description: rawData.Description as string|undefined,
    MD5Sum: md5?.map((v) => {
      const [hash, size, name] = v.trim().split(/\s+/g);
      return {hash, size: parseInt(size), name};
    }),
    SHA1: sha1?.map((v) => {
      const [hash, size, name] = v.trim().split(/\s+/g);
      return {hash, size: parseInt(size), name};
    }),
    SHA256: sha256?.map((v) => {
      const [hash, size, name] = v.trim().split(/\s+/g);
      return {hash, size: parseInt(size), name};
    }),
    SHA512: sha512?.map((v) => {
      const [hash, size, name] = v.trim().split(/\s+/g);
      return {hash, size: parseInt(size), name};
    })
  };
}

export async function getPackages(uri: string, options: {dist: string}) {
  const Release = await getRelease(uri, options);
  if (Release["Acquire-By-Hash"]) {
    if (Release.SHA256) {
      const files = Release.SHA256.filter((v) => /Packages(\.gz|\.xz)?/.test(v.name));
      if (files.length === 0) throw new Error("No Packages file found");
      const dataArray: any[] = [];
      for (const file of files) {
        try {
          const data = (await (file.name.endsWith("Packages") ? (httpRequest.bufferFetch(`${uri}/dists/${options.dist}/${file.name}`)).then(({data}) => data) : file.name.endsWith(".gz") ? promisify(zlib.gunzip)((await httpRequest.bufferFetch(`${uri}/dists/${options.dist}/${file.name}`)).data) : Promise.resolve(""))).toString();
          if (data) {
            dataArray.push({
              file: `${uri}/dists/${options.dist}/${file.name}`,
              Packages: data.split(/^\n/gm).map((v) => {
                const U = DebianPackage.parseControlFile(v);
                U.Filename = `${uri}/${U.Filename}`;
                return U;
              })
            });
          }
        } catch {}
      }
      return dataArray;
    }
  }
  return null;
}

getPackages("http://deb.debian.org/debian", {dist: "stable"}).catch(console.error).then(console.log);