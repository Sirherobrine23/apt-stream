import { aptSConfig, repositoryFrom } from "./configManeger.js";
import { Readable } from "node:stream";
import { Debian } from "@sirherobrine23/coreutils";
import { getFileStream } from "./packgesLoad.js";
import mongoDB from "mongodb";
import nano from "nano";

export type packageStorge = {
  component: string,
  distribution: string,
  control: Debian.debianControl,
  repository: repositoryFrom,
  restore: {
    from: "http",
    url: string,
    headers?: {[key: string]: string},
    query?: {[key: string]: string},
  }|{
    from: "cloud",
    info: string
  }
};

export type packagesFunctions = {
  getPackages(componentName?: string, arch?: string): Promise<packageStorge[]>,
  addPackage(distName: string, control: Debian.debianControl, repository: repositoryFrom, restorePackage: packageStorge["restore"]): Promise<packageStorge>,
  delePackage(control: Partial<Debian.debianControl>): Promise<void>,
  distInfo?(distName: string): Promise<{packages: string[], arch: string[], components: string[]}>,
  getFile?(control: Partial<Debian.debianControl>, componentName?: string, distName?: string): Promise<Readable>,
};

export default async function packageManeger(serverConfig: aptSConfig): Promise<packagesFunctions> {
  if (serverConfig.db?.type === "mongodb") {
    const dbInfo = serverConfig.db;
    const mongoClient = await (new mongoDB.MongoClient(dbInfo.url, {})).connect();
    const collection = mongoClient.db(dbInfo.db || "aptStream").collection<packageStorge>(dbInfo.collection || "packages");
    return {
      async getPackages(componentName, arch) {
        const query: mongoDB.Filter<packageStorge> = {};
        if (componentName) query.component = {$in: [componentName, "all"]};
        if (arch) query.control = {Architecture: arch};
        return (await collection.find(query).toArray()).map(data => {
          delete data._id;
          return data;
        });
      },
      async addPackage(distname, control, repository, restore) {
        const componentName = repository.componentName ||  "main";
        const find = await collection.findOne({
          control: {
            Package: control.Package,
            Version: control.Version,
            Architecture: control.Architecture,
          }
        });
        if (find) return find;

        // add to database
        const data = {
          component: componentName,
          distribution: distname,
          control,
          repository,
          restore
        };
        await collection.insertOne(data);
        return data;
      },
      async delePackage(control) {
        await collection.findOneAndDelete({control});
      },
      async getFile(control, componentName, distName) {
        const findQuery: mongoDB.Filter<packageStorge> = {control};
        if (componentName) findQuery.component = componentName;
        if (distName) findQuery.distribution = distName;
        const data = await collection.findOne(findQuery);
        if (!data) throw new Error("Package not found");
        return getFileStream(data);
      },
    };
  } else if (serverConfig.db?.type === "couchdb") {
    const dbInfo = serverConfig.db;
    const nanoClient = nano(dbInfo.url);
    await new Promise<void>((done, reject) => nanoClient.session().then(res => res.ok ? done() : reject(res)));
    const db = nanoClient.db.use<packageStorge>(dbInfo.dbName || "aptStream");

    return {
      async getPackages(componentName) {
        if (componentName) {
          return db.find({
            selector: {
              componentName: {$in: [componentName, "all"]},
            }
          }).then(res => res.docs);
        }
        return db.list({include_docs: true}).then(res => res.rows.map(row => row.doc));
      },
      async addPackage(distname, control, repository, restore) {
        const componentName = repository.componentName ||  "main";
        const find = await db.find({
          selector: {
            control: {
              Package: control.Package,
              Version: control.Version,
              Architecture: control.Architecture,
            }
          }
        }).then(res => res.docs[0]);
        if (find?.control) return find;

        // add to database
        const data = {
          component: componentName,
          distribution: distname,
          control,
          repository,
          restore
        };
        await db.insert(data);
        return data;
      },
      async delePackage(control) {
        await db.find({selector: {control}}).then(res => res.docs[0]).then(async doc => !!doc ? db.destroy(doc._id, doc._rev) : null);
      }
    };
  }

  throw new Error("No database selected");
  // const packagesArray: packageStorge[] = [];
  // return null;
}