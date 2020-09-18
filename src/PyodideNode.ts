import path from "path";
import fs from "fs";
import fetch from "node-fetch";

/**
 * Provider a configurable pyodide loader that auto-detects its environment and fetches
 * from a custom external pyodide
 */
export class PyodideLoader<T> {
  baseUrl: string;
  wasmUrl: string;
  packagesUrl: string;
  loadedPackages = new Set<string>();
  pyodide: Pyodide<T> | null = null;

  constructor(baseUrl = path.join(__dirname, "assets")) {
    this.baseUrl = baseUrl;
    this.wasmUrl = `${baseUrl}/pyodide.asm.wasm`;
    this.packagesUrl = `${baseUrl}/packages`;
  }

  // Download the webassembly module and then create a usable pyodide instance
  async loadPython(): Promise<Pyodide<{}>> {
    /**
     * [1] Download the webassembly and instantiate the module
     * [2] Build the support methods
     * [3] Load the wasm module into a pyodide shell
     * [4] Wait for the "postRun" to complete and then return the post-processed pyodide
     */

    const locateFile = buildLocateFile(this.baseUrl);
    const checkABI = buildCheckABI();

    const availablePackages: PyodideDepsMap = JSON.parse(
      (await fetch_buffer(`${this.packagesUrl}/packages.json`)).toString()
    );

    const arrayBuffer = await fetch_buffer(this.wasmUrl);

    /**
     * Now that the module methods are prepared, we create a shell for pyodide
     * and then load the wasm into it.
     */
    return new Promise((resolvePyodide, reject) => {
      // Create an empty shell for pyodide to instantiate itself into
      let pyodideInstance: Pyodide<T>;
      let pythonModule: Partial<PyodideModule> = {};

      // Create the parameters for the python module
      pythonModule.packages = availablePackages;
      pythonModule.noImageDecoding = true;
      pythonModule.noAudioDecoding = true;
      pythonModule.noWasmDecoding = true;
      pythonModule.global = process;
      pythonModule.filePackagePrefixURL = this.baseUrl + "/";
      pythonModule.checkABI = checkABI;
      pythonModule.locateFile = locateFile;
      pythonModule.instantiateWasm = (info: any, receiveInstance: any) => {
        WebAssembly.compile(arrayBuffer)
          .then(async (module) => {
            //@ts-ignore
            process["Module"] = pythonModule;
            // Dynamically Load the wasm loader

            // For whatever reason, we need to literally eval this into the scope.
            // Bad.
            let pckgUrl = await fetch_buffer(
              path.join(this.baseUrl, "/pyodide.asm.data.js")
            );
            eval(pckgUrl.toString());

            return WebAssembly.instantiate(module, info);
          })
          .then((instance) => receiveInstance(instance))
          .catch((err) => console.log(`ERROR: ${err}`));
        return {};
      };

      // This will be ran after we re-assigned pyodideInstance
      // At this point, our shell will be supplanted with the wasm module
      pythonModule.postRun = () => {
        pyodideInstance.filePackagePrefixURL = this.packagesUrl;
        pyodideInstance.locateFile = (path) => `${this.packagesUrl}/${path}`;

        pyodideInstance.runPython(
          `import sys; sys.setrecursionlimit(int(${500}))`
        );
        //@ts-ignore
        pyodideInstance.globals = pyodideInstance.runPython(
          'import sys\nsys.modules["__main__"]'
        );
        // Finally, assign some methods that pyodide will use to do things like
        // autocomplete and package loading
        const loadPackage = buildLoadPackage(
          this.packagesUrl,
          this.loadedPackages,
          availablePackages,
          pyodideInstance
        );

        ///@ts-ignore
        pyodideInstance.loadPackage = loadPackage;

        //@ts-ignore
        global.pyodide = { _module: pythonModule };

        //@ts-ignore
        pyodideInstance.then((a) => {
          //@ts-ignore
          pyodideInstance.then = undefined;

          resolvePyodide(pyodideInstance);
          //@ts-ignore
          process.pyodide = pythonModule;

          this.pyodide = pyodideInstance;
        });
      };
      try {
        //@ts-ignore
        process.Module = pythonModule;
        const initializer = require("./assets/pyodide.asm.js");

        // @ts-ignore
        initializer(pythonModule).then((py: Pyodide<T>) => {
          //@ts-ignore
          pyodideInstance = py;
        });
      } catch (err) {
        reject(err);
      }
    });
  }
}

//============================================
// Functions that build pyodides' JS handlers
//============================================

// Pyodide expects this method to verify it has the appropriate public API
const buildCheckABI = () => (ABI: number) => {
  if (ABI !== parseInt("1")) {
    const err = `ABI numbers differ. Expected 1, got ${ABI}`;
    console.error(err);
    throw err;
  }
  return true;
};

const buildLocateFile = (baseUrl: string) => (path: string) => {
  return baseUrl + "/" + path;
};

/**
 * Pyodide expects this method to use in asynchronous package loading
 */
const buildLoadPackage = <T>(
  packagesUrl: string,
  loadedPackages: Set<string>,
  { dependencies }: PyodideDepsMap,
  pyodide: Pyodide<T>
) => async (names?: string[]) => {
  // DFS to find all dependencies of the requested packages
  let queue = [...(names ?? [])];
  let toLoad = new Set<string>();

  while (queue.length) {
    const pckg = queue.pop();
    if (!pckg || !dependencies.hasOwnProperty(pckg)) {
      throw `Unknown package '${pckg}'`;
    }
    if (pckg && !loadedPackages.has(pckg)) {
      toLoad.add(pckg);
      dependencies[pckg].forEach((subpackage) => {
        if (!loadedPackages.has(subpackage) && !toLoad.has(subpackage)) {
          queue.push(subpackage);
        }
      });
    }
  }

  /**
   * Build a promise that hooks into the emscripten's monitorRunDependencies method
   * This watches dynamically linked modules
   *
   * BEWARE: There is no "rejection" method built in here, and the promise will be an
   * unhandled rejection. Please, find a better way!
   */
  return new Promise((resolve, reject) => {
    if (toLoad.size === 0) {
      resolve("No new packages to load");
    }

    pyodide["monitorRunDependencies"] = (remainingDeps: number) => {
      if (remainingDeps === 0) {
        toLoad.forEach((pckg) => loadedPackages.add(pckg));
        delete pyodide.monitorRunDependencies;
        const packageList = Array.from(toLoad.keys()).join(", ");
        resolve(`Loaded ${packageList}`);
      }
    };

    pyodide.runPython(
      "import importlib as _importlib\n" + "_importlib.invalidate_caches()\n"
    );

    const loadDependenciesPromise: Promise<void>[] = [...toLoad].map(
      async (pckg, idx, pckgList) => {
        const pckgLocalURL = path.join(packagesUrl, `/${pckg}.js`);
        if (!fs.existsSync(pckgLocalURL)) {
          throw new Error("package doesn't exist locally!");
        }

        // load dependency
        try {
          require(pckgLocalURL);
        } catch (e) {
          throw new Error(
            `${pckg}.js file does not support NodeJS, please write the support by hand`
          );
        }
      }
    );
    Promise.all(loadDependenciesPromise).catch((err) => {
      reject(err);
    });
  });
};

async function fetch_buffer(filename: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (filename.indexOf("http") == -1) {
      fs.readFile(filename, (err, data) => (err ? reject(err) : resolve(data)));
    } else {
      fetch(filename).then((buff) => resolve(buff.buffer()));
    }
  });
}

//============================
// Pyodide-specific types
//============================

// We add a generic parameter to extend pyodide with a custom globals map
export type Pyodide<T> = PyodidePublic & PyodideModule & { globals: T };

export interface PyodidePublic {
  /**
   * The loaded Package Map
   */
  loadedPackages: { [key: string]: string };

  loadPackage(
    packages: string | string[],
    callback?: MessageCallback,
    errorCallback?: ErrorCallback
  ): Promise<void>;
  runPython(script: string): void;
  runPythonAsync(script: string, callback?: MessageCallback): Promise<any>;
  version(): string;
  pyimport: (name: string) => any;
}

export interface PyodideModule {
  FS: any;
  noImageDecoding: boolean;
  noAudioDecoding: boolean;
  noWasmDecoding: boolean;
  preloadedWasm: any;
  global: any;
  filePackagePrefixURL: string;
  packages: PyodideDepsMap;
  locateFile: (path: string) => string;
  instantiateWasm(info: any, receiveInstance: (instance: any) => void): any;
  postRun(): void;
  checkABI: (a: number) => boolean;
  loadWebAssemblyModule(file: any, flag: boolean): Promise<any>;
  monitorRunDependencies?(n: number): void;
}

export type PyodideDepsMap = {
  dependencies: {
    [id: string]: string[];
  };
  import_name_to_package_name: {
    [id: string]: string;
  };
};

export type MessageCallback = (msg: any) => void;
export type ErrorCallback = (errMsg: any) => void;
