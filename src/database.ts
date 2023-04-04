import * as Debian from "@sirherobrine23/debian";
import { aptStreamConfig } from "./config.js";
import { format } from "node:util";
import mongoDB from "mongodb";
import nano from "nano";

export interface packageData {
  packageComponent: string;
  packageDistribuition: string;
  packageControl: Debian.debianControl;
  fileRestore: any;
  id: string;
}

export interface packageManegerConfig {
  getPackages?(this: packageManeger): Promise<packageData[]>;
  registryPackage?(this: packageManeger, ...args: Parameters<typeof packageManeger["prototype"]["addPackage"]>): ReturnType<typeof packageManeger["prototype"]["addPackage"]>;
  findPackages?(this: packageManeger, search?: {packageName?: string, packageArch?: string, packageComponent?: string, packageDist?: string}): Promise<packageData[]>;
  deleteSource?(this: packageManeger, id: string): Promise<void>;
  close?(): void|Promise<void>;
}

export class packageManeger {
  constructor(options?: packageManegerConfig) {this.#options = options || {}}
  #options?: packageManegerConfig;
  #repoConfig: aptStreamConfig;
  public setConfig(config: aptStreamConfig) {
    this.#repoConfig = config;
    return this;
  }
  #internalPackage: packageData[] = [];
  getPackages = async (): Promise<packageData[]> => {
    if (typeof this.#options.getPackages !== "function") return this.#internalPackage.filter(data => !!data);
    return this.#options.getPackages.call(this);
  }

  async search(search?: {packageName?: string, packageArch?: string, packageComponent?: string, packageDist?: string}): Promise<packageData[]> {
    search ??= {};
    if (typeof this.#options.findPackages !== "function") return (await this.getPackages()).filter(data => ((!search.packageName) || (search.packageName === data.packageControl.Package)) && ((!search.packageArch) || (data.packageControl.Architecture === search.packageArch)) && ((!search.packageComponent) || (data.packageComponent === search.packageComponent)) && ((!search.packageDist) || (data.packageDistribuition === search.packageDist)));
    return this.#options.findPackages.call(this, search);
  }

  addPackage = async (distName: string, componentName: string, repoID: string, fileRestore: any, control: Debian.debianControl): Promise<{distName: string, componentName: string, control: Debian.debianControl}> => {
    if ((await this.search({
      packageName: control.Package,
      packageComponent: componentName,
      packageArch: control.Architecture,
      packageDist: distName
    })).find(d => (d.packageControl.Version === control.Version))) throw new Error(format("%s/%s_%s already exists registered!", control.Package, control.Architecture, control.Version));
    if (typeof this.#options.registryPackage !== "function") this.#internalPackage.push({packageDistribuition: distName, packageComponent: componentName, id: repoID, fileRestore, packageControl: control});
    else await Promise.resolve().then(() => this.#options.registryPackage.call(this, distName, componentName, repoID, fileRestore, control));
    return {
      componentName,
      distName,
      control
    };
  }

  async deleteRepositorySource(id: string): Promise<void> {
    if (typeof this.#options?.deleteSource === "function") {
      await Promise.resolve().then(() => this.#options.deleteSource.call(this, id));
      return;
    }
    for (const packIndex in this.#internalPackage) {
      if (!this.#internalPackage[packIndex]) continue;
      if (this.#internalPackage[packIndex].id !== id) continue;
      delete this.#internalPackage[packIndex];
    }
  }
  async close() {
    if (typeof this.#options?.close === "function") await Promise.resolve().then(() => this.#options.close());
  }
  async Sync() {
    const packagesArray = await this.search();
    const toDelete = packagesArray.filter(pkg => !(this.#repoConfig.repository[pkg.packageDistribuition]?.source?.find(d => d.id === pkg.id)));
    await Promise.all(toDelete.map(async pkg => this.deleteRepositorySource(pkg.id)));
    return Array.from(new Set(toDelete.map(pkg => pkg.id)));
  }
}

export async function connect(config: aptStreamConfig) {
  const { database } = config;
  if (database.drive === "mongodb") {
    const client = await (new mongoDB.MongoClient(database.url)).connect();
    client.on("error", err => console.error(err));
    const collection = client.db(database.databaseName ?? "apt-stream").collection<packageData>(database.collection ?? "packages");
    return new packageManeger({
      async close() {
        await client.close();
      },
      async getPackages() {
        return Array.from((await collection.find().toArray()).map((data): packageData => {
          delete data._id;
          return data;
        }));
      },
      async registryPackage(distName, componentName, repoID, fileRestore, control) {
        if (!control) throw new Error("Error mal formado!");
        await collection.insertOne({
          packageComponent: componentName,
          packageDistribuition: distName,
          id: repoID,
          packageControl: control,
          fileRestore,
        });

        return {
          componentName,
          distName,
          control,
        };
      },
      async deleteSource(id) {
        await collection.findOneAndDelete({id});
      },
    }).setConfig(config);
  } else if (database.drive === "couchdb") {
    const nanoClient = nano(database.url);
    await new Promise<void>((done, reject) => nanoClient.session().then(res => res.ok ? done() : reject(res)));
    const db = nanoClient.db.use<packageData>(database.databaseName ?? "aptStream");
    return new packageManeger({
      async getPackages() {
        return (await db.list({include_docs: true})).rows.map(data => data.doc);
      },
      async registryPackage(distName, componentName, repoID, fileRestore, control) {
        await db.insert({
          packageDistribuition: distName,
          packageComponent: componentName,
          id: repoID,
          packageControl: control,
          fileRestore,
        });

        return {
          componentName,
          distName,
          control
        };
      },
      async deleteSource(id) {
        await db.list({include_docs: true}).then(data => data.rows.map(({doc}) => doc)).then(docs => docs.filter((doc) => doc.id === id)).then(data => Promise.all(data.map(async doc => db.destroy(doc._id, doc._rev))));
      },
    }).setConfig(config);
  }

  return new packageManeger().setConfig(config);
}