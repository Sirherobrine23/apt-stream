import fs from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { Connection } from "./config.js";
import { debianControl, dpkg } from "@sirherobrine23/dpkg";
import path from "node:path";
import { extendsFS } from "@sirherobrine23/extends";
import { finished } from "node:stream/promises";
import { compressStream } from "@sirherobrine23/decompress";

export async function createPackage(db: Connection, repository: string) {
  const repo = db.repoConfig.get(repository);
  const packageArray = await db.packageCollection.find({ $and: Array.from(repo.keys()).map(i => ({ repositorys: [i] })) }).toArray();
  const cc = packageArray.reduce<{ [k: string]: { [c: string]: debianControl[] } }>((acc, info) => {
    info.repositorys.filter(info => info.repository === repository).forEach(repoID => {
      acc[repo.get(repoID.origim).componentName] ??= {};
      acc[repo.get(repoID.origim).componentName][info.control.Architecture] ??= [];
      acc[repo.get(repoID.origim).componentName][info.control.Architecture].push(info.control);
    });
    return acc;
  }, {});
  const repositoryRoot = path.join(db.repoConfig.tmpFolder, "dists", repository);
  for (const componentName in cc) {
    for (const arch in cc[componentName]) {
      if (!(await extendsFS.exists(path.join(repositoryRoot, componentName, arch)))) await fs.mkdir(path.join(repositoryRoot, componentName, arch), { recursive: true });
      const file = path.join(repositoryRoot, componentName, arch, "packages");
      const wr = createWriteStream(file);
      for (const index in cc[componentName][arch]) {
        const control = cc[componentName][arch][index];
        if (Number(index) > 0) wr.write(Buffer.from("\n"));
        await new Promise<void>((done, reject) => wr.write(dpkg.createControl(control), err => err ? reject(err) : done()));
      }
      wr.close();
      await finished(wr);
      await finished(createReadStream(file).pipe(compressStream("gzip")).pipe(createWriteStream(file + ".gz")));
      await finished(createReadStream(file).pipe(compressStream("xz")).pipe(createWriteStream(file + ".xz")));
    }
  }
}