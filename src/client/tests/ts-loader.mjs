import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const parentPath = fileURLToPath(context.parentURL);
    const parentDir = path.dirname(parentPath);
    const resolvedBase = path.resolve(parentDir, specifier);
    if (!existsSync(resolvedBase)) {
      for (const ext of ['.ts', '.tsx']) {
        if (existsSync(resolvedBase + ext)) {
          return {
            url: pathToFileURL(resolvedBase + ext).href,
            shortCircuit: true,
          };
        }
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const filePath = fileURLToPath(url);
    const source = await fs.readFile(filePath, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      fileName: filePath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    return {
      format: 'module',
      shortCircuit: true,
      source: outputText,
    };
  }
  return nextLoad(url, context);
}
