import { MongoClient, ServerApiVersion } from "mongodb";
import { promises as fs } from "node:fs";
import { aptSConfig , repositoryFrom} from "./configManeger.js";
import { DebianPackage } from "@sirherobrine23/coreutils";
import stream from "node:stream";
import path from "node:path";
import coreUtils from "@sirherobrine23/coreutils";
import tar from "tar";

export type restoreStream = {
  from: "url",
  url: string
}|{
  from: "docker",
  digest: string,
  image: string,
  path: string
}|{
  from: "tar",
  url: string,
  filePath: string
};

export type packageStorage<T extends string|DebianPackage.debianControl, U extends string|restoreStream, V extends string|repositoryFrom = repositoryFrom> = {
  dist: string,
  component: string,
  package: T,
  restoreStream: U,
  repositoryFrom?: V
};

export type packagesManeger = {
  getDists: () => Promise<string[]>,
  getDistInfo: (dist: string) => Promise<{components: string[], arch: string[], packages: string[]}>,
  getPackages: (dist?: string, component?: string) => Promise<packageStorage<DebianPackage.debianControl, restoreStream, repositoryFrom>[]>,
  getFileStream: (dist: string, component: string, packageName: string, version: string, arch: string) => Promise<stream.Readable>,
  addPackage: (config: packageStorage<DebianPackage.debianControl, restoreStream, repositoryFrom>) => Promise<void>,
  deletePackage: (config: packageStorage<DebianPackage.debianControl, restoreStream, repositoryFrom>) => Promise<void>,
};

export default packageManeger;
export async function packageManeger(serverConfig: aptSConfig) {
  const partialConfig: Partial<packagesManeger> = {};
  if (serverConfig.db.type === "mongodb") {
    const dbConfig = serverConfig.db;
    console.log("Connecting to MongoDB...");
    const mongoClient = await (new MongoClient(serverConfig.db.url, {serverApi: ServerApiVersion.v1})).connect();
    const collection = mongoClient.db(dbConfig.db ?? "apt-stream").collection<packageStorage<DebianPackage.debianControl, restoreStream, repositoryFrom>>(dbConfig.collection ?? "packages");
    console.log("Connected to MongoDB!");

    partialConfig.getDists = async () => (await collection.distinct("dist"));
    partialConfig.getDistInfo = async (dist) => {
      const packages = await collection.find({dist}).toArray();
      if (!packages.length) throw new Error("Distribution not found!");
      return packages.reduce((dist, curr) => {
        if (!dist.components) dist.components = [];
        if (!dist.arch) dist.arch = [];
        if (!dist.packages) dist.packages = [];
        if (!dist.components.includes(curr.component)) dist.components.push(curr.component);
        if (!dist.arch.includes(curr.package.architecture as any)) dist.arch.push(curr.package.architecture as any);
        if (!dist.packages.includes(curr.package.package as any)) dist.packages.push(curr.package.package as any);
        return dist;
      }, {} as Partial<Awaited<ReturnType<packagesManeger["getDistInfo"]>>>) as Awaited<ReturnType<packagesManeger["getDistInfo"]>>;
    }
    partialConfig.getPackages = async (dist, component) => {
      const query: any = {};
      if (dist) query.dist = dist;
      if (component) query.component = component;
      return collection.find(query).toArray();
    }
    partialConfig.getFileStream = async (dist, component, packageName, version, arch) => {
      const packageData = await collection.findOne({dist, component, "package.package": packageName, "package.version": version, "package.architecture": arch});
      if (!packageData) throw new Error("Package not found!");
      if (typeof packageData.restoreStream === "string") packageData.restoreStream = JSON.parse(packageData.restoreStream);
      if (packageData.restoreStream.from === "url") {
        if (packageData.repositoryFrom?.type === "http") return coreUtils.httpRequest.pipeFetch({
          url: packageData.restoreStream.url,
          headers: packageData.repositoryFrom.auth?.header,
          query: packageData.repositoryFrom.auth?.query
        });
        return coreUtils.httpRequest.pipeFetch(packageData.restoreStream.url);
      } else if (packageData.restoreStream.from === "tar") {
        const inf = packageData.restoreStream;
        const tarStream = coreUtils.httpRequestLarge.Tar(packageData.restoreStream.url);
        return new Promise((resolve, reject) => {
          tarStream.listFiles((data) => {
            if (data.path === inf.filePath) return resolve(data as any);
          }).catch(reject).then(() => reject(new Error("File not found!")));
        });
      } else if (packageData.restoreStream.from === "docker") {
        const inf = packageData.restoreStream;
        const oci = await coreUtils.DockerRegistry(inf.image, packageData.repositoryFrom?.type === "docker" ? packageData.repositoryFrom.platformConfig : undefined);
          return new Promise((done, reject) => {
            oci.blobLayerStream(inf.digest).then((stream) => {
              stream.pipe(tar.list({
                filter: (path) => path === inf.path,
                onentry: (entry) => done(entry as any)
              }))
            }).catch(reject);
          });
      }
      throw new Error("Restore stream not supported!");
    }

    partialConfig.addPackage = async (config) => {}
    partialConfig.deletePackage = async (config) => {}
  } else if (serverConfig.db.type === "internal") {
    const rootSave = path.resolve(serverConfig.db.rootPath);
    if (!await coreUtils.extendFs.exists(rootSave)) await fs.mkdir(rootSave, {recursive: true});
  } else {
    const interalPackages: packageStorage<DebianPackage.debianControl, restoreStream>[] = [];
    console.log(interalPackages);
  }

  return partialConfig as packagesManeger;
}