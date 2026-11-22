'use strict';
/**
 * Node cannot require the TypeScript sources (the scoring package's imports have no extension, and the
 * app's use the `@/` alias), so outside Jest they are transpiled on the fly with the project's own
 * TypeScript, and the tsconfig aliases are resolved here.
 */
const fs = require('fs');
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function installTsHook() {
  if (process.env.JEST_WORKER_ID !== undefined || require.extensions['.ts']) return;
  const ts = require('typescript');
  require.extensions['.ts'] = (module, filename) => {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename,
    });
    module._compile(out.outputText, filename);
  };
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    let mapped = request;
    if (request === '@scoring') mapped = path.join(ROOT, 'packages', 'scoring', 'src', 'index.ts');
    else if (request.startsWith('@scoring/')) mapped = path.join(ROOT, 'packages', 'scoring', 'src', request.slice('@scoring/'.length));
    else if (request.startsWith('@/')) mapped = path.join(ROOT, 'src', request.slice(2));
    return resolve.call(this, mapped, ...rest);
  };
}

installTsHook();
