import { createRequire } from "node:module";
import { CompilerOptions, CreateProgramOptions } from "typescript";
import { getPackageInfo, resolveModule } from "local-pkg";
import { major } from "semver";
import { MkdistOptions } from "../make";
import { extractDeclarations } from "./dts";

const require = createRequire(import.meta.url);

const compilerOptions: CompilerOptions = {
  allowJs: true,
  declaration: true,
  incremental: true,
  skipLibCheck: true,
  strictNullChecks: true,
  emitDeclarationOnly: true,
  allowNonTsExtensions: true,
};

export async function getVueDeclarations(
  vfs: Map<string, string>,
  opts?: MkdistOptions,
) {
  const fileMapping = getFileMapping(vfs);
  const srcFiles = Object.keys(fileMapping);
  const originFiles = Object.values(fileMapping);
  if (originFiles.length === 0) {
    return;
  }

  const pkgInfo = await getPackageInfo("vue-tsc");
  if (!pkgInfo) {
    console.warn(
      "[mkdist] Please install `vue-tsc` to generate Vue SFC declarations.",
    );
    return;
  }

  const majorVersion = major(pkgInfo.version);
  switch (majorVersion) {
    case 1: {
      await emitVueTscV1(vfs, srcFiles);
      break;
    }
    case 2: {
      await emitVueTscV2(vfs, srcFiles);
      break;
    }
  }

  return extractDeclarations(vfs, originFiles, opts);
}

const SFC_EXT_RE = /\.vue\.[cm]?[jt]s$/;

function getFileMapping(vfs: Map<string, string>): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  for (const [srcPath] of vfs) {
    if (SFC_EXT_RE.test(srcPath)) {
      files[srcPath.replace(SFC_EXT_RE, ".vue")] = srcPath;
    }
  }
  return files;
}

async function emitVueTscV1(vfs: Map<string, string>, srcFiles: string[]) {
  const vueTsc: typeof import("vue-tsc1") = await import("vue-tsc")
    .then((r) => r.default || r)
    .catch(() => undefined);

  // Inside vue-tsc, `require` is used instead of `import`. In order to override `ts.sys`, it is necessary to import it in the same way as vue-tsc for them to refer to the same file.
  const ts =
    require("typescript") as typeof import("typescript/lib/tsserverlibrary");

  const tsHost = ts.createCompilerHost(compilerOptions);

  const _tsSysWriteFile = ts.sys.writeFile;
  ts.sys.writeFile = (filename, content) => {
    vfs.set(filename, content);
  };
  const _tsSysReadFile = ts.sys.readFile;
  ts.sys.readFile = (filename, encoding) => {
    if (vfs.has(filename)) {
      return vfs.get(filename);
    }
    return _tsSysReadFile(filename, encoding);
  };

  try {
    const program = vueTsc.createProgram({
      rootNames: srcFiles,
      options: compilerOptions,
      host: tsHost,
    });

    program.emit();
  } finally {
    ts.sys.writeFile = _tsSysWriteFile;
    ts.sys.readFile = _tsSysReadFile;
  }
}

async function emitVueTscV2(vfs: Map<string, string>, srcFiles: string[]) {
  const ts: typeof import("typescript") = await import("typescript");
  const vueTsc: typeof import("vue-tsc") = await import("vue-tsc");
  const requireFromVueTsc = createRequire(resolveModule("vue-tsc"));
  const vueLangaugeCore = requireFromVueTsc("@vue/language-core");
  const volarTs = requireFromVueTsc("@volar/typescript");

  const tsHost = ts.createCompilerHost(compilerOptions);
  tsHost.writeFile = (filename, content) => {
    vfs.set(filename, content);
  };
  const _tsReadFile = tsHost.readFile.bind(tsHost);
  tsHost.readFile = (filename) => {
    if (vfs.has(filename)) {
      return vfs.get(filename);
    }
    return _tsReadFile(filename);
  };
  const _tsFileExist = tsHost.fileExists.bind(tsHost);
  tsHost.fileExists = (filename) => {
    return vfs.has(filename) || _tsFileExist(filename);
  };

  const programOptions: CreateProgramOptions = {
    rootNames: srcFiles,
    options: compilerOptions,
    host: tsHost,
  };

  const fakeGlobalTypesHolder =
    vueTsc.createFakeGlobalTypesHolder(programOptions);
  const createProgram = volarTs.proxyCreateProgram(
    ts,
    ts.createProgram,
    [".vue"],
    (ts, options) => {
      const vueLanguagePlugin = vueLangaugeCore.createVueLanguagePlugin(
        ts,
        (id) => id,
        (fileName) => fileName === fakeGlobalTypesHolder,
        options.options,
        vueLangaugeCore.resolveVueCompilerOptions({}),
        false,
      );
      return [vueLanguagePlugin];
    },
  );

  const program = createProgram(programOptions);
  program.emit();
}
