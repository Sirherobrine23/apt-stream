import * as Debian from "@sirherobrine23/debian";
import { aptStreamConfig } from "./config.js";
import mongoDB from "mongodb";
import nano from "nano";

export interface packageData {
  packageComponent: string;
  packageDistribuition: string;
  packageControl: Debian.debianControl;
}

export interface packageManegerConfig {
  getPackages(this: packageManeger): Promise<packageData[]>;
  registryPackage?(this: packageManeger, distName: string, componentName: string, control: Debian.debianControl): Promise<{distName: string, componentName: string, packageName: string}>;
  findPackages?(this: packageManeger, search: {packageName?: string, packageArch?: string, packageComponent?: string, packageDist?: string}): Promise<packageData[]>;
}

export class packageManeger {
  constructor(private options: packageManegerConfig) {}
  getPackages = async (): Promise<packageData[]> => {
    if (typeof this.options.getPackages !== "function") throw new Error("Get packages disabled by Backend");
    return this.options.getPackages.call(this);
  }

  search = async (search: {packageName?: string, packageArch?: string, packageComponent?: string, packageDist?: string}): ReturnType<typeof this.options.findPackages> => {
    if (typeof this.options.findPackages !== "function") return (await this.getPackages()).filter(data => ((!search.packageName) || (search.packageName !== data.packageControl.Package)) && ((!search.packageArch) || (data.packageControl.Architecture !== search.packageArch)) && ((!search.packageComponent) || (data.packageComponent !== search.packageComponent)) && ((!search.packageDist) || (data.packageDistribuition !== search.packageDist)));
    return this.options.findPackages.call(this, search);
  }

  addPackage = async (distName: string, componentName: string, control: Debian.debianControl): ReturnType<typeof this.options.registryPackage> => {
    if (typeof this.options.registryPackage !== "function") throw new Error("Add package disabled");
    return this.options.registryPackage.call(this, distName, componentName, control);
  }
}

export async function connect(config: aptStreamConfig) {
  const { database } = config;
  if (database.drive === "mongodb") {
    const client = await (new mongoDB.MongoClient(database.url)).connect();
    const collection = client.db(database.databaseName ?? "apt-stream").collection<packageData>(database.collection ?? "packages");
    return new packageManeger({
      async getPackages() {
        return Array.from((await collection.find().toArray()).map((data): packageData => {
          delete data._id;
          return data;
        }));
      },
      async registryPackage(distName, componentName, control) {
        if ((await this.search({packageName: control.Package, packageComponent: componentName, packageArch: control.Architecture})).find(d => (d.packageDistribuition === distName) && (d.packageControl.Version === control.Version))) throw new Error("Package exists!");
        await collection.insertOne({
          packageComponent: componentName,
          packageDistribuition: distName,
          packageControl: control,
        });

        return {
          componentName,
          distName,
          packageName: control.Package
        };
      }
    });
  } else if (database.drive === "couchdb") {
    const nanoClient = nano(database.url);
    await new Promise<void>((done, reject) => nanoClient.session().then(res => res.ok ? done() : reject(res)));
    const db = nanoClient.db.use<packageData>(database.databaseName ?? "aptStream");

    return new packageManeger({
      async getPackages() {
        return (await db.list({include_docs: true})).rows.map(data => data.doc);
      },
      async registryPackage(distName, componentName, control) {
        if ((await this.search({packageName: control.Package, packageComponent: componentName, packageArch: control.Architecture})).find(d => (d.packageDistribuition === distName) && (d.packageControl.Version === control.Version))) throw new Error("Package exists!");
        await db.insert({
          packageDistribuition: distName,
          packageComponent: componentName,
          packageControl: control
        });

        return {
          componentName,
          distName,
          packageName: control.Package
        };
      },
    });
  }

  const packagesStorage: packageData[] = [];
  return new packageManeger({
    async getPackages() {
      return Array.from(packagesStorage);
    },
    async registryPackage(distName, componentName, control) {
      if ((await this.search({packageName: control.Package, packageComponent: componentName, packageArch: control.Architecture})).find(d => (d.packageDistribuition === distName) && (d.packageControl.Version === control.Version))) throw new Error("Package exists!");
      packagesStorage.push({
        packageDistribuition: distName,
        packageComponent: componentName,
        packageControl: control
      });
      return {
        componentName,
        distName,
        packageName: control.Package
      };
    },
  });
}