import {
  writeWindowsPackageRuntimeQualificationIndex
} from './external-qualification-evidence.mjs';

const admitted = writeWindowsPackageRuntimeQualificationIndex();
console.log(
  `Windows package runtime evidence indexed for ${admitted.qualifiedIds.join(', ')}: ${admitted.index.path}`
);
