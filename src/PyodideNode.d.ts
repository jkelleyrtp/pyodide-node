/**
 * Provider a configurable pyodide loader that auto-detects its environment and fetches
 * from a custom external pyodide
 */
export declare class PyodideLoader<T> {
    baseUrl: string;
    wasmUrl: string;
    packagesUrl: string;
    loadedPackages: Set<string>;
    pyodide: Pyodide<T> | null;
    constructor(baseUrl?: string);
    loadPython(): Promise<Pyodide<{}>>;
}
export declare type Pyodide<T> = PyodidePublic & PyodideModule & {
    globals: T;
};
export interface PyodidePublic {
    /**
     * The loaded Package Map
     */
    loadedPackages: {
        [key: string]: string;
    };
    loadPackage(packages: string | string[], callback?: MessageCallback, errorCallback?: ErrorCallback): Promise<void>;
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
export declare type PyodideDepsMap = {
    dependencies: {
        [id: string]: string[];
    };
    import_name_to_package_name: {
        [id: string]: string;
    };
};
export declare type MessageCallback = (msg: any) => void;
export declare type ErrorCallback = (errMsg: any) => void;
