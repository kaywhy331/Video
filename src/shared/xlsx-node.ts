import * as fs from 'node:fs';
import { lazyNodeModule } from './lazy-node-module';

type XlsxModule = typeof import('xlsx');

export type { WorkBook } from 'xlsx';

const loadXlsx = lazyNodeModule<XlsxModule>('xlsx');
let configured = false;

function xlsx(): XlsxModule {
  const module = loadXlsx();
  if (!configured) {
    module.set_fs(fs);
    configured = true;
  }
  return module;
}

export const XLSX = new Proxy({} as XlsxModule, {
  get: (_target, property) => {
    const module = xlsx();
    const value = Reflect.get(module, property, module) as unknown;
    return typeof value === 'function' ? value.bind(module) : value;
  }
});
