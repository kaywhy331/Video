import * as fs from 'node:fs';
import * as XLSX from 'xlsx';

XLSX.set_fs(fs);

export { XLSX };
